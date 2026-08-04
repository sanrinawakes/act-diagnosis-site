import fs from 'node:fs/promises';

const [command, ...args] = process.argv.slice(2);
const baseUrl = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://act-diagnosis-site.vercel.app'
).replace(/\/$/, '');
const secret =
  process.env.SUPPORT_AUTOMATION_SECRET ||
  process.env.MONITORING_CRON_SECRET ||
  process.env.CRON_SECRET ||
  '';

if (!secret) {
  throw new Error(
    'SUPPORT_AUTOMATION_SECRET, MONITORING_CRON_SECRET, or CRON_SECRET is required'
  );
}

if (command === 'list') {
  const limit = Number(args[0]) || 10;
  const createdAfter = args[1]
    ? `&created_after=${encodeURIComponent(args[1])}`
    : '';
  await request(
    `/api/internal/support-automation?limit=${Math.min(Math.max(limit, 1), 20)}${createdAfter}`
  );
} else if (['claim', 'heartbeat', 'release'].includes(command)) {
  const [ticketId, runId] = args;
  requireValue(ticketId, 'ticket id');
  requireValue(runId, 'run id');
  await request('/api/internal/support-automation', {
    action: command,
    ticket_id: ticketId,
    run_id: runId,
  });
} else if (command === 'hold') {
  const [ticketId, runId, reasonFile] = args;
  requireValue(ticketId, 'ticket id');
  requireValue(runId, 'run id');
  requireValue(reasonFile, 'reason file');
  const reason = await fs.readFile(reasonFile, 'utf8');
  await request('/api/internal/support-automation', {
    action: 'hold',
    ticket_id: ticketId,
    run_id: runId,
    reason,
  });
} else if (command === 'decision') {
  const [ticketId, runId, decisionFile] = args;
  requireValue(ticketId, 'ticket id');
  requireValue(runId, 'run id');
  requireValue(decisionFile, 'decision file');
  const decision = await fs.readFile(decisionFile, 'utf8');
  await request('/api/internal/support-automation', {
    action: 'decision',
    ticket_id: ticketId,
    run_id: runId,
    decision,
  });
} else if (command === 'reply') {
  const [ticketId, runId, payloadFile] = args;
  requireValue(ticketId, 'ticket id');
  requireValue(runId, 'run id');
  requireValue(payloadFile, 'reply payload file');
  const payload = JSON.parse(await fs.readFile(payloadFile, 'utf8'));
  await request('/api/internal/support-automation', {
    ...payload,
    action: 'reply',
    ticket_id: ticketId,
    run_id: runId,
  });
} else if (
  ['quality-claim', 'quality-heartbeat', 'quality-release'].includes(command)
) {
  const [incidentId, runId] = args;
  requireValue(incidentId, 'quality incident id');
  requireValue(runId, 'run id');
  await request('/api/internal/support-automation', {
    action: command.replace('-', '_'),
    quality_incident_id: incidentId,
    run_id: runId,
  });
} else if (command === 'quality-resolve') {
  const [incidentId, runId, payloadFile] = args;
  requireValue(incidentId, 'quality incident id');
  requireValue(runId, 'run id');
  requireValue(payloadFile, 'quality resolution payload file');
  const payload = JSON.parse(await fs.readFile(payloadFile, 'utf8'));
  await request('/api/internal/support-automation', {
    ...payload,
    action: 'quality_resolve',
    quality_incident_id: incidentId,
    run_id: runId,
  });
} else {
  throw new Error(
    'Usage: support-automation-client.mjs list|claim|heartbeat|release|hold|decision|reply|quality-claim|quality-heartbeat|quality-release|quality-resolve'
  );
}

async function request(path, body) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 30_000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: abortController.signal,
    });
    const responseText = await response.text();
    let responseBody;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = { error: responseText };
    }

    process.stdout.write(`${JSON.stringify(responseBody, null, 2)}\n`);
    if (!response.ok) process.exitCode = 1;
  } finally {
    clearTimeout(timeoutId);
  }
}

function requireValue(value, label) {
  if (!value) throw new Error(`${label} is required`);
}
