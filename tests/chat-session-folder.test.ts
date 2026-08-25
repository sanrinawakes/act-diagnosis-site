import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('chat session folders and rename', () => {
  it('adds a nullable folder column with a partial index', () => {
    const migration = fs.readFileSync(
      path.join(root, 'supabase/migrations/033_add_chat_session_folder.sql'),
      'utf8'
    );
    expect(migration).toContain(
      "ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS folder text"
    );
    expect(migration).toContain('idx_chat_sessions_user_folder');
    expect(migration).toContain('WHERE folder IS NOT NULL');
  });

  it('accepts folder updates and validates them in the sessions API', () => {
    const route = fs.readFileSync(
      path.join(root, 'src/app/api/chat/sessions/route.ts'),
      'utf8'
    );
    // PATCH accepts folder, allows null to clear, trims, and caps at 50 chars
    expect(route).toContain(
      "const { session_id, is_pinned, title, folder } = body;"
    );
    expect(route).toContain("folder.trim().length > 50");
    expect(route).toContain(
      "updateData.folder = folder === null ? null : folder.trim();"
    );
    // GET filters by folder and returns the distinct folder list
    expect(route).toContain("url.searchParams.get('folder')");
    expect(route).toContain("sessionsQuery.eq('folder', folder)");
    expect(route).toMatch(/folders,\s*\}\);/);
  });

  it('exposes rename and folder controls in the coaching sidebar', () => {
    const page = fs.readFileSync(
      path.join(root, 'src/app/coaching/page.tsx'),
      'utf8'
    );
    expect(page).toContain('handleRenameSession');
    expect(page).toContain('handleMoveToFolder');
    expect(page).toContain('session-rename-input');
    expect(page).toContain('session-folder-input');
    expect(page).toContain('data-testid="sidebar-folders"');
    // IME safety: Enter while composing must not submit
    expect(page.match(/isComposing/g)?.length).toBeGreaterThanOrEqual(2);
    // moving to a folder never sends an empty name
    expect(page).toContain('folderEditValue.trim()');
  });

  it('ignores stale sidebar responses during rapid search changes', () => {
    const page = fs.readFileSync(
      path.join(root, 'src/app/coaching/page.tsx'),
      'utf8'
    );
    expect(page).toContain('const sidebarRequestSequenceRef = useRef(0);');
    expect(page).toContain(
      'const requestSequence = ++sidebarRequestSequenceRef.current;'
    );
    expect(
      page.match(
        /requestSequence !== sidebarRequestSequenceRef\.current/g
      )?.length
    ).toBeGreaterThanOrEqual(2);
    expect(page).toContain(
      'requestSequence === sidebarRequestSequenceRef.current'
    );
    expect(page).toContain(
      'const sidebarRequestControllerRef = useRef<AbortController | null>(null);'
    );
    expect(page).toContain('sidebarRequestControllerRef.current?.abort();');
    expect(page).toContain('sidebarRequestControllerRef.current = controller;');
    expect(page).toContain('const SIDEBAR_SEARCH_DEBOUNCE_MS = 250;');
    expect(page).toContain(
      'setDebouncedSidebarSearch(sidebarSearch);'
    );
    expect(page).toContain(
      'fetchSidebarSessions(debouncedSidebarSearch, sidebarTab, 1, folderFilter);'
    );
  });
});
