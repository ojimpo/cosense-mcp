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

    it('空文字やカンマだけの指定は未設定として扱う', () => {
      expect(getProjectAllowList({ COSENSE_PROJECT_ALLOW_LIST: '  ' })).toBeUndefined();
      expect(getProjectAllowList({ COSENSE_PROJECT_ALLOW_LIST: ' , , ' })).toBeUndefined();
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
      expect(message).toContain("Project 'other' is not allowed");
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
