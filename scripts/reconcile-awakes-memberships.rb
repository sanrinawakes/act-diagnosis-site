#!/usr/bin/env ruby
# frozen_string_literal: true

require 'csv'
require 'date'
require 'json'
require 'net/http'
require 'optparse'
require 'time'
require 'uri'

options = { apply: false }
OptionParser.new do |parser|
  parser.banner = 'Usage: reconcile-awakes-memberships.rb --members FILE --renewals FILE [--apply]'
  parser.on('--members FILE', 'AWAKES management-scenario CSV (CP932)') { |value| options[:members] = value }
  parser.on('--renewals FILE', 'AWAKES renewal-scenario CSV (CP932)') { |value| options[:renewals] = value }
  parser.on('--apply', 'Apply verified terms and then revoke expired/undated access') { options[:apply] = true }
end.parse!

abort 'Both --members and --renewals are required' unless options[:members] && options[:renewals]

def read_myasp_csv(path)
  CSV.read(path, headers: true, encoding: 'Windows-31J:UTF-8', liberal_parsing: true)
rescue EncodingError, CSV::MalformedCSVError => e
  abort "Could not parse #{File.basename(path)} as CP932: #{e.class}"
end

def normalized_email(row)
  row['メールアドレス'].to_s.strip.downcase
end

def normalized_name(row)
  [row['姓'], row['名']].map { |value| value.to_s.gsub(/[[:space:]]+/, '') }.join("\u0000")
end

def received_and_subscribed?(row)
  row['受領状態'] == '受領済み' && row['購読状態'] == '購読中'
end

def parse_japan_time(value)
  Time.strptime("#{value} +0900", '%Y-%m-%d %H:%M:%S %z').iso8601
rescue ArgumentError
  nil
end

members = read_myasp_csv(options[:members]).select { |row| received_and_subscribed?(row) }
renewal_rows = read_myasp_csv(options[:renewals]).select { |row| received_and_subscribed?(row) }

member_by_email = {}
duplicate_member_emails = 0
members.each do |row|
  email = normalized_email(row)
  next if email.empty?

  duplicate_member_emails += 1 if member_by_email.key?(email)
  member_by_email[email] ||= row
end

renewal_by_email = {}
duplicate_paid_renewals = 0
renewal_rows.each do |row|
  email = normalized_email(row)
  next if email.empty?

  duplicate_paid_renewals += 1 if renewal_by_email.key?(email)
  renewal_by_email[email] ||= row
end

members_by_name = member_by_email.values.group_by { |row| normalized_name(row) }
renewal_member_emails = {}
matched_by_email = 0
matched_by_unique_name = 0
unmatched_renewals = 0

renewal_by_email.each do |renewal_email, renewal|
  if member_by_email.key?(renewal_email)
    renewal_member_emails[renewal_email] = true
    matched_by_email += 1
    next
  end

  name_matches = members_by_name[normalized_name(renewal)] || []
  if name_matches.length == 1
    renewal_member_emails[normalized_email(name_matches.first)] = true
    matched_by_unique_name += 1
  else
    unmatched_renewals += 1
  end
end

invalid_start_dates = 0
records = member_by_email.map do |email, row|
  started_at = parse_japan_time(row['登録日'])
  invalid_start_dates += 1 unless started_at
  {
    email: email,
    started_at: started_at,
    renewal_cycle: renewal_member_emails[email] ? 1 : 0,
    event_id: "legacy:ZegCYNDX:#{row['ユーザーID'].to_s.strip}",
  }
end

duplicate_event_ids = records.group_by { |record| record[:event_id] }.count { |_key, rows| rows.length > 1 }
invalid_records = records.count do |record|
  record[:email].empty? || !record[:email].include?('@') || !record[:started_at] ||
    record[:event_id].end_with?(':')
end
now = Time.now
expired_terms = records.count do |record|
  started_at = Time.iso8601(record[:started_at])
  expiry = started_at.to_datetime >> (12 * (record[:renewal_cycle] + 1))
  expiry.to_time <= now
end

summary = {
  mode: options[:apply] ? 'apply' : 'dry_run',
  current_members: records.length,
  paid_renewal_emails: renewal_by_email.length,
  duplicate_member_emails: duplicate_member_emails,
  duplicate_paid_renewal_rows: duplicate_paid_renewals,
  renewal_matches_by_email: matched_by_email,
  renewal_matches_by_unique_name: matched_by_unique_name,
  unmatched_paid_renewals: unmatched_renewals,
  invalid_start_dates: invalid_start_dates,
  duplicate_event_ids: duplicate_event_ids,
  invalid_records: invalid_records,
  terms_already_expired: expired_terms,
  terms_current: records.length - expired_terms,
}

puts JSON.generate(summary)
exit 2 unless duplicate_member_emails.zero? && unmatched_renewals.zero? &&
              invalid_start_dates.zero? && duplicate_event_ids.zero? && invalid_records.zero?
exit 0 unless options[:apply]

supabase_url = ENV['NEXT_PUBLIC_SUPABASE_URL'] || ENV['SUPABASE_URL']
service_key = ENV['SUPABASE_SERVICE_ROLE_KEY']
abort 'Supabase URL and service-role key are required for --apply' if supabase_url.to_s.empty? || service_key.to_s.empty?

def call_rpc(base_url, service_key, function_name, payload)
  uri = URI.join(base_url.end_with?('/') ? base_url : "#{base_url}/", "rest/v1/rpc/#{function_name}")
  request = Net::HTTP::Post.new(uri)
  request['apikey'] = service_key
  request['Authorization'] = "Bearer #{service_key}"
  request['Content-Type'] = 'application/json'
  request['Accept-Encoding'] = 'identity'
  request.body = JSON.generate(payload)
  response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https') do |http|
    http.open_timeout = 10
    http.read_timeout = 30
    http.request(request)
  end
  raise "RPC #{function_name} failed with HTTP #{response.code}" unless response.is_a?(Net::HTTPSuccess)

  JSON.parse(response.body)
end

applied = 0
duplicates = 0
blocked = 0
records.each do |record|
  response = call_rpc(
    supabase_url,
    service_key,
    'apply_awakes_membership_event',
    {
      p_email: record[:email],
      p_event_type: 'legacy_import',
      p_external_event_id: record[:event_id],
      p_occurred_at: record[:started_at],
      p_renewal_cycle: record[:renewal_cycle],
      p_source: 'myasp_import',
    }
  )
  event_status = response.is_a?(Array) ? response.first&.fetch('status', nil) : response['status']
  case event_status
  when 'duplicate' then duplicates += 1
  when 'account_not_eligible' then blocked += 1
  else applied += 1
  end
end

expiry_result = call_rpc(supabase_url, service_key, 'expire_awakes_memberships', {})
puts JSON.generate(
  applied_memberships: applied,
  duplicate_memberships: duplicates,
  blocked_memberships: blocked,
  expiry_result: expiry_result,
)
