'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type Locale = 'ja' | 'en';

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

// UI translations
const translations: Record<Locale, Record<string, string>> = {
  ja: {
    // Header
    'nav.mypage': 'マイページ',
    'nav.diagnosis': '診断',
    'nav.results': '結果',
    'nav.coaching': 'AIコーチング',
    'nav.profile': 'プロフィール',
    'nav.admin': '管理画面',
    'nav.logout': 'ログアウト',
    'nav.login': 'ログイン',
    'nav.register': '新規登録',
    'nav.siteName': 'ACTI',

    // Home
    'home.title': 'ACTI',
    'home.subtitle': 'あなたの意識レベルと行動パターンを診断し、\nAI コーチングで自己成長をサポートします',
    'home.toMypage': 'マイページへ',
    'home.takeDiagnosis': '診断を受ける',
    'home.aiCoaching': 'AIコーチング',
    'home.feature1.title': '詳細診断',
    'home.feature1.desc': '27 種類の ACT タイプと 6 つの意識レベルから、あなたの特性を正確に診断します',
    'home.feature2.title': 'AI コーチング',
    'home.feature2.desc': 'あなたの診断結果に基づいて、AI コーチが個別にサポートします',
    'home.feature3.title': '進捗管理',
    'home.feature3.desc': '診断結果を記録して、あなたの成長を可視化できます',

    // Login
    'login.title': 'ログイン',
    'login.welcome': 'ACTIへようこそ',
    'login.email': 'メールアドレス',
    'login.password': 'パスワード',
    'login.submit': 'ログイン',
    'login.loading': 'ログイン中...',
    'login.or': 'または',
    'login.noAccount': 'アカウントをお持ちでないですか？',
    'login.register': '新規登録',
    'login.error.invalid': 'メールアドレスまたはパスワードが正しくありません',
    'login.error.failed': 'ログインに失敗しました',

    // Register
    'register.title': '新規登録',
    'register.subtitle': 'ACTIコーチングを始めましょう',
    'register.displayName': '表示名',
    'register.email': 'メールアドレス',
    'register.password': 'パスワード（6文字以上）',
    'register.submit': 'アカウントを作成',
    'register.loading': '作成中...',
    'register.hasAccount': 'すでにアカウントをお持ちですか？',
    'register.login': 'ログイン',

    // Dashboard
    'dashboard.greeting': 'さん、こんにちは',
    'dashboard.default': 'マイページ',
    'dashboard.welcome': 'ACTIコーチングへようこそ',
    'dashboard.diagnosisCount': '診断回数',
    'dashboard.chatSessions': 'チャットセッション',
    'dashboard.currentType': '現在のタイプ',
    'dashboard.undiagnosed': '未診断',
    'dashboard.latestResult': '最新の診断結果',
    'dashboard.level': '意識レベル',
    'dashboard.diagnosisDate': '診断日',
    'dashboard.viewDetail': '詳細を見る',
    'dashboard.getCoaching': 'AIコーチングを受ける',
    'dashboard.noDiagnosis': 'まだ診断を受けていません',
    'dashboard.noDiagnosisDesc': 'ACTIであなたのタイプと意識レベルを確認しましょう',
    'dashboard.takeDiagnosis': '診断を受ける',
    'dashboard.quickDiagnosis': '診断を受ける',
    'dashboard.quickDiagnosisDesc': 'ACTタイプを診断',
    'dashboard.quickHistory': '診断履歴',
    'dashboard.quickHistoryDesc': '過去の結果一覧',
    'dashboard.quickCoaching': 'AIコーチング',
    'dashboard.quickCoachingDesc': 'AIに相談する',
    'dashboard.quickProfile': 'プロフィール',
    'dashboard.quickProfileDesc': 'アカウント設定',

    // Diagnosis
    'diagnosis.title': 'ACTIテスト',
    'diagnosis.description': 'このテストは、あなたの現在の意識レベルと性格タイプを診断するものです。',
    'diagnosis.copyright.title': '著作権表示：',
    'diagnosis.copyright.text1': '本診断テストの内容、デザイン、システムは著作権で保護されています。このテストの結果は個人利用のみを目的としており、商業的な利用、無断複製、配布は禁止されています。',
    'diagnosis.copyright.text2': 'このテストを受けることで、あなたはこの利用条件に同意したものとみなされます。',
    'diagnosis.copyright.agree': '著作権表示に同意し、テストを開始します',
    'diagnosis.startTest': 'テストを開始',
    'diagnosis.cancel': 'キャンセル',
    'diagnosis.question': '質問',
    'diagnosis.back': '戻る',
    'diagnosis.next': '次へ',
    'diagnosis.complete': '完了',
    'diagnosis.saving': '診断結果を保存中...',
    'diagnosis.interstitial.title': '次は、あなたの',
    'diagnosis.interstitial.highlight': '【ふだんの行動や好み】',
    'diagnosis.interstitial.about': 'について',
    'diagnosis.interstitial.desc1': 'ここからは、あなたのふだんの行動パターンや好みについてお聞きします。',
    'diagnosis.interstitial.desc2': '正解や不正解はありません。あなたの実際の傾向を素直にお答えください。',
    'diagnosis.interstitial.note': 'このセクションでは、122個の質問があります。各質問では「どちらが正しいか」ではなく、「あなたが普段どちらを選びがちか」でお答えください。',
    'diagnosis.interstitial.start': '性格診断を開始',
    'diagnosis.personality.guidance': '※「どちらが正しいか」ではなく、「普段どちらを選びがちか」で答えてください。',
    'diagnosis.growth.title': '成長経験について',
    'diagnosis.growth.desc': '以下の8つの選択肢から、あなたが最も成長を感じたものを',
    'diagnosis.growth.count': '2つ選んでください',
    'diagnosis.growth.selected': '選択中',
    'diagnosis.growth.submit': '次へ進む',
    'diagnosis.immaturity.title': '未熟さへの気づき',
    'diagnosis.immaturity.desc': '以下の6つの選択肢から、あなたが最も当てはまるものを',
    'diagnosis.immaturity.count': '1つ選んでください',
    'diagnosis.immaturity.submit': '診断を完了',

    // Results
    'results.title': '診断結果一覧',
    'results.noResults': 'まだ診断結果がありません',
    'results.takeFirst': '最初の診断を受ける',
    'results.level': '意識レベル',
    'results.viewDetail': '詳細を見る',

    // Result Detail
    'resultDetail.backToList': '← 結果一覧に戻る',
    'resultDetail.typeCode': 'タイプコード',
    'resultDetail.consciousnessLevel': '意識レベル',
    'resultDetail.axisTitle': '3つの軸の説明',
    'resultDetail.axis1Label': '1文字目',
    'resultDetail.axis2Label': '2文字目',
    'resultDetail.axis3Label': '3文字目',
    'resultDetail.axis1.S': 'あなたは内向的なエネルギーを持つ人です。深い思考と内省を重視します。',
    'resultDetail.axis1.P': 'あなたは外向的なエネルギーを持つ人です。行動と周囲との関わりを重視します。',
    'resultDetail.axis1.M': 'あなたはバランスの取れたエネルギーを持つ人です。状況に応じて柔軟に対応します。',
    'resultDetail.axis2.V': 'あなたは理想や価値観を大切にする理想型です。',
    'resultDetail.axis2.G': 'あなたは現実や実用性を重視する現実型です。',
    'resultDetail.axis2.M': 'あなたはバランス感覚に優れたバランス型です。',
    'resultDetail.axis3.A': 'あなたは論理的で客観的な判断を重視する論理型です。',
    'resultDetail.axis3.E': 'あなたは感情や共感を大切にする感情型です。',
    'resultDetail.axis3.M': 'あなたは論理と感情のバランスを取る中立型です。',
    'resultDetail.levelTitle': '意識レベルについて',
    'resultDetail.levelLabel': 'レベル',
    'resultDetail.level1Desc': '防衛レベルでは、あなたは困難や脅威から身を守ることに集中しています。安全と安心を最優先とし、変化よりも現状維持を好みます。',
    'resultDetail.level2Desc': '著しい葛藤レベルでは、あなたは内的な矛盾や対立を感じています。異なる価値観や欲求のバランスを取ることに苦労しています。',
    'resultDetail.level3Desc': '自立レベルでは、あなたは自分の価値観に基づいて独立して判断し、行動できます。自己責任と個人の成長を重視しています。',
    'resultDetail.level4Desc': '調和レベルでは、あなたは個人の欲求と周囲との関係のバランスを取ることができます。共感と協働を大切にしながらも、自分の目標を追求します。',
    'resultDetail.level5Desc': '創造レベルでは、あなたは新しい可能性を見出し、他者にインスピレーションを与えることができます。個人の成長と周囲への貢献の統合を実現しています。',
    'resultDetail.level6Desc': '解脱（視野の超越）レベルでは、あなたはあらゆる二項対立を超え、より大きな視野を持って世界を理解しています。普遍的な真理と個別の現象の関連を知覚します。',
    'resultDetail.getCoaching': 'AIコーチングを受ける',
    'resultDetail.retakeDiagnosis': 'もう一度診断する',
    'resultDetail.notFound': '診断結果が見つかりません',
    'resultDetail.loadError': '診断結果の読み込みに失敗しました',

    // Profile
    'profile.title': 'プロフィール設定',
    'profile.displayName': '表示名',
    'profile.email': 'メールアドレス',
    'profile.role': '権限',
    'profile.registered': '登録日',
    'profile.save': '保存',
    'profile.saving': '保存中...',
    'profile.saved': '保存しました',
    'profile.changePassword': 'パスワード変更',
    'profile.newPassword': '新しいパスワード',
    'profile.update': '変更',
    'profile.updating': '変更中...',
    'profile.updated': 'パスワードを変更しました',

    // Coaching
    'coaching.title': 'AIコーチング',
    'coaching.placeholder': 'メッセージを入力...',
    'coaching.send': '送信',
    'coaching.botDisabled': 'AIコーチングは現在メンテナンス中です',
    'coaching.noDiagnosis': 'まず診断を受けてからAIコーチングをご利用ください',
    'coaching.takeDiagnosis': '診断を受ける',

    // Common
    'common.loading': '読み込み中...',
    'common.admin': '管理者',
    'common.member': 'メンバー',
  },
  en: {
    // Header
    'nav.mypage': 'My Page',
    'nav.diagnosis': 'Diagnosis',
    'nav.results': 'Results',
    'nav.coaching': 'AI Coaching',
    'nav.profile': 'Profile',
    'nav.admin': 'Admin',
    'nav.logout': 'Logout',
    'nav.login': 'Login',
    'nav.register': 'Sign Up',
    'nav.siteName': 'ACT Diagnosis',

    // Home
    'home.title': 'ACT Diagnosis',
    'home.subtitle': 'Discover your consciousness level and behavioral patterns,\nwith AI coaching to support your personal growth',
    'home.toMypage': 'My Page',
    'home.takeDiagnosis': 'Take Diagnosis',
    'home.aiCoaching': 'AI Coaching',
    'home.feature1.title': 'In-Depth Diagnosis',
    'home.feature1.desc': 'Accurately assess your traits from 27 ACT types and 6 consciousness levels',
    'home.feature2.title': 'AI Coaching',
    'home.feature2.desc': 'Receive personalized support from an AI coach based on your diagnosis results',
    'home.feature3.title': 'Progress Tracking',
    'home.feature3.desc': 'Record your diagnosis results and visualize your growth over time',

    // Login
    'login.title': 'Login',
    'login.welcome': 'Welcome to ACT Diagnosis',
    'login.email': 'Email',
    'login.password': 'Password',
    'login.submit': 'Login',
    'login.loading': 'Logging in...',
    'login.or': 'or',
    'login.noAccount': "Don't have an account?",
    'login.register': 'Sign Up',
    'login.error.invalid': 'Invalid email or password',
    'login.error.failed': 'Login failed',

    // Register
    'register.title': 'Sign Up',
    'register.subtitle': "Let's get started with ACT Diagnosis Coaching",
    'register.displayName': 'Display Name',
    'register.email': 'Email',
    'register.password': 'Password (6+ characters)',
    'register.submit': 'Create Account',
    'register.loading': 'Creating...',
    'register.hasAccount': 'Already have an account?',
    'register.login': 'Login',

    // Dashboard
    'dashboard.greeting': ', welcome back',
    'dashboard.default': 'My Page',
    'dashboard.welcome': 'Welcome to ACT Diagnosis Coaching',
    'dashboard.diagnosisCount': 'Diagnoses',
    'dashboard.chatSessions': 'Chat Sessions',
    'dashboard.currentType': 'Current Type',
    'dashboard.undiagnosed': 'Not yet',
    'dashboard.latestResult': 'Latest Diagnosis Result',
    'dashboard.level': 'Consciousness Level',
    'dashboard.diagnosisDate': 'Date',
    'dashboard.viewDetail': 'View Details',
    'dashboard.getCoaching': 'Get AI Coaching',
    'dashboard.noDiagnosis': "You haven't taken a diagnosis yet",
    'dashboard.noDiagnosisDesc': 'Take the ACT Diagnosis to discover your type and consciousness level',
    'dashboard.takeDiagnosis': 'Take Diagnosis',
    'dashboard.quickDiagnosis': 'Take Diagnosis',
    'dashboard.quickDiagnosisDesc': 'Discover your ACT type',
    'dashboard.quickHistory': 'History',
    'dashboard.quickHistoryDesc': 'Past results',
    'dashboard.quickCoaching': 'AI Coaching',
    'dashboard.quickCoachingDesc': 'Chat with AI',
    'dashboard.quickProfile': 'Profile',
    'dashboard.quickProfileDesc': 'Account settings',

    // Diagnosis
    'diagnosis.title': 'ACT Diagnosis Test',
    'diagnosis.description': 'This test assesses your current consciousness level and personality type.',
    'diagnosis.copyright.title': 'Copyright Notice:',
    'diagnosis.copyright.text1': 'The content, design, and system of this diagnostic test are protected by copyright. Results are for personal use only. Commercial use, unauthorized reproduction, or distribution is prohibited.',
    'diagnosis.copyright.text2': 'By taking this test, you agree to these terms of use.',
    'diagnosis.copyright.agree': 'I agree to the copyright notice and wish to start the test',
    'diagnosis.startTest': 'Start Test',
    'diagnosis.cancel': 'Cancel',
    'diagnosis.question': 'Question',
    'diagnosis.back': 'Back',
    'diagnosis.next': 'Next',
    'diagnosis.complete': 'Complete',
    'diagnosis.saving': 'Saving your results...',
    'diagnosis.interstitial.title': "Next, let's explore your ",
    'diagnosis.interstitial.highlight': 'everyday behaviors and preferences',
    'diagnosis.interstitial.about': '',
    'diagnosis.interstitial.desc1': "From here, we'll ask about your typical behavioral patterns and preferences.",
    'diagnosis.interstitial.desc2': "There are no right or wrong answers. Please respond honestly based on your actual tendencies.",
    'diagnosis.interstitial.note': 'This section contains 122 questions. For each question, choose not what you think is "correct," but what you tend to do in practice.',
    'diagnosis.interstitial.start': 'Start Personality Assessment',
    'diagnosis.personality.guidance': '* Choose not what you think is "correct," but what you naturally tend to do.',
    'diagnosis.growth.title': 'Growth Experiences',
    'diagnosis.growth.desc': 'From the 8 options below, select the ones where you felt the most personal growth — ',
    'diagnosis.growth.count': 'choose 2',
    'diagnosis.growth.selected': 'Selected',
    'diagnosis.growth.submit': 'Continue',
    'diagnosis.immaturity.title': 'Awareness of Immaturity',
    'diagnosis.immaturity.desc': 'From the 6 options below, select the one that best describes you — ',
    'diagnosis.immaturity.count': 'choose 1',
    'diagnosis.immaturity.submit': 'Complete Diagnosis',

    // Results
    'results.title': 'Diagnosis Results',
    'results.noResults': 'No diagnosis results yet',
    'results.takeFirst': 'Take Your First Diagnosis',
    'results.level': 'Consciousness Level',
    'results.viewDetail': 'View Details',

    // Result Detail
    'resultDetail.backToList': '← Back to Results',
    'resultDetail.typeCode': 'Type Code',
    'resultDetail.consciousnessLevel': 'Consciousness Level',
    'resultDetail.axisTitle': 'The Three Axes Explained',
    'resultDetail.axis1Label': '1st Letter',
    'resultDetail.axis2Label': '2nd Letter',
    'resultDetail.axis3Label': '3rd Letter',
    'resultDetail.axis1.S': 'You have introverted energy. You value deep thinking and introspection.',
    'resultDetail.axis1.P': 'You have extroverted energy. You value action and engagement with others.',
    'resultDetail.axis1.M': 'You have balanced energy. You adapt flexibly to different situations.',
    'resultDetail.axis2.V': 'You are an idealist who values principles and vision.',
    'resultDetail.axis2.G': 'You are a realist who prioritizes practicality.',
    'resultDetail.axis2.M': 'You have an excellent sense of balance.',
    'resultDetail.axis3.A': 'You are a logic-oriented type who values objective judgment.',
    'resultDetail.axis3.E': 'You are an emotion-oriented type who values empathy.',
    'resultDetail.axis3.M': 'You balance logic and emotion in your decisions.',
    'resultDetail.levelTitle': 'About Your Consciousness Level',
    'resultDetail.levelLabel': 'Level',
    'resultDetail.level1Desc': 'At the Defense level, you focus on protecting yourself from difficulties and threats. You prioritize safety and security, preferring stability over change.',
    'resultDetail.level2Desc': 'At the Significant Inner Conflict level, you experience internal contradictions and tensions. You struggle to balance different values and desires.',
    'resultDetail.level3Desc': 'At the Independence level, you can make independent decisions and act based on your own values. You prioritize personal responsibility and growth.',
    'resultDetail.level4Desc': 'At the Harmony level, you can balance personal desires with relationships. You value empathy and collaboration while pursuing your goals.',
    'resultDetail.level5Desc': 'At the Creation level, you can discover new possibilities and inspire others. You have integrated personal growth with contribution to those around you.',
    'resultDetail.level6Desc': 'At the Liberation level, you have transcended all dualities and understand the world with a broader perspective. You perceive the connection between universal truth and individual phenomena.',
    'resultDetail.getCoaching': 'Get AI Coaching',
    'resultDetail.retakeDiagnosis': 'Take Diagnosis Again',
    'resultDetail.notFound': 'Diagnosis result not found',
    'resultDetail.loadError': 'Failed to load diagnosis result',

    // Profile
    'profile.title': 'Profile Settings',
    'profile.displayName': 'Display Name',
    'profile.email': 'Email',
    'profile.role': 'Role',
    'profile.registered': 'Registered',
    'profile.save': 'Save',
    'profile.saving': 'Saving...',
    'profile.saved': 'Saved successfully',
    'profile.changePassword': 'Change Password',
    'profile.newPassword': 'New Password',
    'profile.update': 'Update',
    'profile.updating': 'Updating...',
    'profile.updated': 'Password updated',

    // Coaching
    'coaching.title': 'AI Coaching',
    'coaching.placeholder': 'Type a message...',
    'coaching.send': 'Send',
    'coaching.botDisabled': 'AI Coaching is currently under maintenance',
    'coaching.noDiagnosis': 'Please take a diagnosis first before using AI Coaching',
    'coaching.takeDiagnosis': 'Take Diagnosis',

    // Common
    'common.loading': 'Loading...',
    'common.admin': 'Admin',
    'common.member': 'Member',
  },
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ja');

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('act-locale') : null;
    if (saved === 'en' || saved === 'ja') {
      setLocaleState(saved);
    }
  }, []);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('act-locale', newLocale);
    }
  };

  const t = (key: string): string => {
    return translations[locale][key] || translations['ja'][key] || key;
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}
