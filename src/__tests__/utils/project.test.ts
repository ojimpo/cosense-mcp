import {
  getProjectAllowList,
  isProjectAllowed,
  checkProjectAllowed,
} from '../../utils/project.js';

const DEFAULT = 'kouki';

describe('COSENSE_PROJECT_ALLOW_LIST', () => {
  describe('未設定（後方互換）', () => {
    it('どのプロジェクトも許可される', () => {
      // projectName の上書きはマルチプロジェクト対応の意図的な仕様。
      // 既定では従来どおり制限しない。
      expect(isProjectAllowed('anything', DEFAULT, undefined)).toBe(true);
      expect(checkProjectAllowed('anything', DEFAULT, undefined)).toBeUndefined();
    });
  });

  describe('設定されているが実質空', () => {
    // 変数を書いた人は制限したい意図なので、「設定したつもりで無制限」には倒さない
    // （upstream の要望で入った挙動）。未設定と空は別物
    it('空文字・空白・カンマだけは空配列（＝制限モード）になる', () => {
      expect(getProjectAllowList({ COSENSE_PROJECT_ALLOW_LIST: '' })).toEqual([]);
      expect(getProjectAllowList({ COSENSE_PROJECT_ALLOW_LIST: '  ' })).toEqual([]);
      expect(getProjectAllowList({ COSENSE_PROJECT_ALLOW_LIST: ' , , ' })).toEqual([]);
    });

    it('既定プロジェクトだけが許可される', () => {
      expect(isProjectAllowed(DEFAULT, DEFAULT, [])).toBe(true);
      expect(isProjectAllowed('other', DEFAULT, [])).toBe(false);
    });

    it('既定プロジェクトも無ければ何も許可されず、理由は (none) と出る', () => {
      expect(isProjectAllowed('any', undefined, [])).toBe(false);
      expect(checkProjectAllowed('any', undefined, [])).toContain('Permitted projects: (none)');
    });
  });

  describe('設定あり', () => {
    const env = { COSENSE_PROJECT_ALLOW_LIST: 'kouki, team ,shared' } as NodeJS.ProcessEnv;
    const list = getProjectAllowList(env);

    it('前後の空白を落として解釈する', () => {
      expect(getProjectAllowList(env)).toEqual(['kouki', 'team', 'shared']);
    });

    it('リスト内は許可', () => {
      expect(isProjectAllowed('team', DEFAULT, list)).toBe(true);
    });

    it('リスト外は拒否し、理由に許可リストを載せる', () => {
      const message = checkProjectAllowed('other', DEFAULT, list);
      expect(message).toContain("Project 'other' is not allowed by COSENSE_PROJECT_ALLOW_LIST");
      expect(message).toContain('kouki, team, shared');
    });

    it('既定プロジェクトはリストに無くても暗黙に許可される', () => {
      expect(isProjectAllowed(DEFAULT, DEFAULT, ['team'])).toBe(true);
    });

    it('projectName が未指定なら判定しない（既定プロジェクトが使われるため）', () => {
      expect(checkProjectAllowed(undefined, DEFAULT, list)).toBeUndefined();
    });

    it('大文字小文字は区別する', () => {
      // Scrapbox のページ解決は寛容だが、ここで寛容にすると
      // 許可していないプロジェクトが表記違いで通ってしまう
      expect(isProjectAllowed('Team', DEFAULT, list)).toBe(false);
    });
  });
});
