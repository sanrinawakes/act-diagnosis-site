import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  push: vi.fn(),
  getUser: vi.fn(),
  fetch: vi.fn(),
  setItem: vi.fn(),
}));

// These tests execute the page's handlers and inspect its rendered React tree.
// A tiny hook host avoids introducing a DOM implementation just for this page.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = mocks.cursor++;
      if (!(index in mocks.slots)) {
        mocks.slots[index] = typeof initial === 'function' ? initial() : initial;
      }
      return [mocks.slots[index], (value: unknown) => {
        mocks.slots[index] = typeof value === 'function' ? value(mocks.slots[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      const index = mocks.cursor++;
      if (!(index in mocks.slots)) mocks.slots[index] = { current: initial };
      return mocks.slots[index];
    },
    useEffect: (effect: () => unknown, dependencies?: unknown[]) => {
      const index = mocks.cursor++;
      const previous = mocks.slots[index] as unknown[] | undefined;
      if (!dependencies || !previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        mocks.effects.push(effect);
      }
      mocks.slots[index] = dependencies;
    },
    useMemo: (factory: () => unknown, dependencies: unknown[]) => {
      const index = mocks.cursor++;
      const previous = mocks.slots[index] as { dependencies: unknown[]; value: unknown } | undefined;
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        mocks.slots[index] = { dependencies, value: factory() };
      }
      return (mocks.slots[index] as { value: unknown }).value;
    },
    useCallback: (callback: unknown) => callback,
  };
});

const router = { push: mocks.push };
const supabase = { auth: { getUser: mocks.getUser } };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/supabase', () => ({ createClient: () => supabase }));

import FreeDiagnosisPage from '@/app/free/diagnosis/page';
import { consciousnessQuestions } from '@/data/consciousness-questions';

const questions = consciousnessQuestions.slice(0, 15);
type Element = ReactElement<Record<string, unknown>>;

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && 'props' in node) {
    return text((node as Element).props.children as ReactNode);
  }
  return '';
}

function render() {
  mocks.cursor = 0;
  const tree = FreeDiagnosisPage();
  const pending = mocks.effects.splice(0);
  pending.forEach((effect) => effect());
  return tree;
}

function button(label: string): Element {
  const match = elements(render()).find((element) => element.type === 'button' && text(element.props.children as ReactNode) === label);
  expect(match, `button ${label} should be visible`).toBeDefined();
  return match!;
}

function click(element: Element) {
  expect(element.props.disabled).not.toBe(true);
  return (element.props.onClick as () => unknown)();
}

function choose(questionIndex: number, choiceIndex: number) {
  click(button(questions[questionIndex].choices[choiceIndex].text));
}

function selectedChoiceIndexes(questionIndex: number) {
  const current = elements(render()).filter((element) => element.type === 'button');
  return questions[questionIndex].choices.flatMap((choice, index) => {
    const match = current.find((element) => text(element.props.children as ReactNode) === choice.text)!;
    return String(match.props.className).includes('border-blue-400 bg-blue-50') ? [index] : [];
  });
}

async function mount() {
  render();
  await Promise.resolve();
  render();
}

function answerAll(choiceIndexes = questions.map((question) => question.choices.length - 1)) {
  choiceIndexes.forEach((choiceIndex, questionIndex) => {
    choose(questionIndex, choiceIndex);
    if (questionIndex < questions.length - 1) click(button('次へ'));
  });
  return choiceIndexes.map((choiceIndex, questionIndex) => questions[questionIndex].choices[choiceIndex].score);
}

function expectRecoverableError() {
  const alerts = elements(render()).filter((element) => element.props.role === 'alert');
  expect(alerts.length, 'save failure should be explained visibly').toBeGreaterThan(0);
  expect(text(render())).toContain(questions[14].text);
  expect(button('完了').props.disabled).not.toBe(true);
  expect(mocks.push).not.toHaveBeenCalledWith('/free/results');
  expect(mocks.setItem).not.toHaveBeenCalledWith('free_diagnosis_result', expect.any(String));
}

describe('free diagnosis choices and saving', () => {
  beforeEach(() => {
    mocks.slots = [];
    mocks.cursor = 0;
    mocks.effects = [];
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'test-user', email: 'member@example.test' } } });
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', mocks.fetch);
    vi.stubGlobal('localStorage', { setItem: mocks.setItem });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('leaves Next disabled until the current question has a choice', async () => {
    await mount();
    expect(button('戻る').props.disabled).toBe(true);
    expect(button('次へ').props.disabled).toBe(true);
    choose(0, 0);
    click(button('次へ'));
    expect(button('次へ').props.disabled).toBe(true);
  });

  it('redirects an unauthenticated visitor to login without offering or saving a diagnosis', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    await mount();
    expect(mocks.push).toHaveBeenCalledWith('/login');
    expect(elements(render()).some((element) => element.type === 'button')).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.setItem).not.toHaveBeenCalled();
  });

  it('cannot skip an unanswered question or submit the unanswered final question', async () => {
    await mount();
    for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
      const next = button(questionIndex < questions.length - 1 ? '次へ' : '完了');
      expect(next.props.disabled).toBe(true);
      // Exercise the defensive handler as well as the disabled UI, without
      // forcing hook state into an unreachable incomplete-final-page scenario.
      await (next.props.onClick as () => unknown)();
      expect(text(render())).toContain(questions[questionIndex].text);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.setItem).not.toHaveBeenCalled();
      choose(questionIndex, 0);
      if (questionIndex < questions.length - 1) click(button('次へ'));
    }
  });

  it('highlights exactly the clicked choice for all 83 options, including duplicate scores', async () => {
    await mount();
    let checked = 0;
    const mismatches: string[] = [];
    for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
      for (let choiceIndex = 0; choiceIndex < questions[questionIndex].choices.length; choiceIndex++) {
        choose(questionIndex, choiceIndex);
        const selected = selectedChoiceIndexes(questionIndex);
        if (selected.length !== 1 || selected[0] !== choiceIndex) {
          mismatches.push(`Q${questionIndex + 1} choice ${choiceIndex + 1}: selected ${selected.map((index) => index + 1).join(',')}`);
        }
        checked++;
      }
      if (questionIndex < questions.length - 1) click(button('次へ'));
    }
    expect(checked).toBe(83);
    expect(mismatches).toEqual([]);
  });

  it('retains exact duplicate-score choices on next/back and replaces them when changed', async () => {
    await mount();
    choose(0, 5);
    click(button('次へ'));
    choose(1, 5);
    click(button('戻る'));
    expect(selectedChoiceIndexes(0)).toEqual([5]);
    choose(0, 2);
    click(button('次へ'));
    expect(selectedChoiceIndexes(1)).toEqual([5]);
    click(button('戻る'));
    expect(selectedChoiceIndexes(0)).toEqual([2]);
  });

  it.each([{ lowAnswers: 2, level: 2 }, { lowAnswers: 3, level: 1 }])('submits scores rather than choice indexes and keeps the -2 count $lowAnswers level boundary', async ({ lowAnswers, level }) => {
    await mount();
    const choices = questions.map((question, index) => question.choices.findIndex((choice) => index < lowAnswers ? choice.score === -2 : choice.score !== -2));
    const expectedScores = answerAll(choices);
    await click(button('完了'));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = mocks.fetch.mock.calls[0];
    expect(url).toBe('/api/free/diagnosis');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ email: 'member@example.test', answers: expectedScores, level, typeCode: 'MMM' });
    expect(mocks.setItem).toHaveBeenCalledWith('free_diagnosis_result', JSON.stringify({ level, typeCode: 'MMM' }));
    expect(mocks.push).toHaveBeenCalledWith('/free/results');
  });

  it('does not publish a local result or navigate before server confirmation', async () => {
    let complete!: (response: Response) => void;
    mocks.fetch.mockReturnValue(new Promise<Response>((resolve) => { complete = resolve; }));
    await mount();
    answerAll();
    const saving = click(button('完了'));
    expect(mocks.setItem).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    complete(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await saving;
    expect(mocks.push).toHaveBeenCalledWith('/free/results');
  });

  it('blocks same-tick double completion while a save is pending', async () => {
    let complete!: (response: Response) => void;
    mocks.fetch.mockReturnValue(new Promise<Response>((resolve) => { complete = resolve; }));
    await mount();
    answerAll();
    const finish = button('完了');
    const first = click(finish);
    const second = click(finish);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    complete(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await Promise.all([first, second]);
  });

  it.each([400, 401, 403, 500, 'network disconnect'] as const)('keeps all answers and shows a retry after $0 without publishing an unsaved result', async (failure) => {
    if (typeof failure === 'number') mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Save rejected' }), { status: failure }));
    else mocks.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await mount();
    const scores = answerAll();
    await click(button('完了'));
    expectRecoverableError();
    for (let questionIndex = questions.length - 1; questionIndex >= 0; questionIndex--) {
      expect(selectedChoiceIndexes(questionIndex)).toEqual([questions[questionIndex].choices.length - 1]);
      if (questionIndex > 0) click(button('戻る'));
    }
    for (let questionIndex = 0; questionIndex < questions.length - 1; questionIndex++) click(button('次へ'));
    await click(button('完了'));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).answers).toEqual(scores);
    expect(mocks.push).toHaveBeenCalledWith('/free/results');
  });

  it.each(['negative acknowledgement', 'invalid JSON'])('requires a valid successful server acknowledgement after HTTP 200: $0', async (failure) => {
    const body = failure === 'invalid JSON' ? 'not JSON' : JSON.stringify({ success: false });
    mocks.fetch.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await mount();
    answerAll();
    await click(button('完了'));
    expectRecoverableError();
  });

  it('retries local result storage without repeating a save already confirmed by the server', async () => {
    mocks.setItem.mockImplementationOnce(() => { throw new DOMException('Storage disabled', 'SecurityError'); });
    await mount();
    answerAll();
    await click(button('完了'));
    expect(elements(render()).some((element) => element.props.role === 'alert')).toBe(true);
    expect(selectedChoiceIndexes(14)).toEqual([questions[14].choices.length - 1]);
    expect(mocks.push).not.toHaveBeenCalledWith('/free/results');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await click(button('完了'));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.setItem).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenCalledWith('/free/results');
  });

  it('saves changed answers again after a confirmed save followed by local storage failure', async () => {
    mocks.setItem.mockImplementationOnce(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
    await mount();
    const scores = answerAll();
    await click(button('完了'));
    choose(14, 0);
    scores[14] = questions[14].choices[0].score;
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await click(button('完了'));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).answers).toEqual(scores);
    expect(mocks.push).toHaveBeenCalledWith('/free/results');
  });

  it('aborts a stalled save within one minute, then allows a retry with the same answers', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    mocks.fetch.mockImplementationOnce((_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = request.signal as AbortSignal;
      requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    await mount();
    const scores = answerAll();
    const saving = click(button('完了'));
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requestSignal?.aborted).toBe(true);
    await saving;
    expectRecoverableError();
    await click(button('完了'));
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).answers).toEqual(scores);
    expect(mocks.push).toHaveBeenCalledWith('/free/results');
  });
});
