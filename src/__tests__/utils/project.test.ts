import {
  getProjectAllowList,
  isProjectAllowed,
  projectNotAllowedMessage,
  checkProjectAllowed,
} from '@/utils/project.js';

describe('COSENSE_PROJECT_ALLOW_LIST', () => {
  const originalAllowList = process.env.COSENSE_PROJECT_ALLOW_LIST;

  afterEach(() => {
    if (originalAllowList === undefined) {
      delete process.env.COSENSE_PROJECT_ALLOW_LIST;
    } else {
      process.env.COSENSE_PROJECT_ALLOW_LIST = originalAllowList;
    }
  });

  describe('getProjectAllowList', () => {
    test('未設定なら undefined（無制限）を返すこと', () => {
      delete process.env.COSENSE_PROJECT_ALLOW_LIST;
      expect(getProjectAllowList()).toBeUndefined();
    });

    test('空文字・空白のみなら undefined を返すこと', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = '   ';
      expect(getProjectAllowList()).toBeUndefined();
    });

    test('カンマ区切りを分割すること', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha,beta';
      expect(getProjectAllowList()).toEqual(['alpha', 'beta']);
    });

    test('各要素の前後の空白をトリムし、空要素を無視すること', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = ' alpha , , beta ,';
      expect(getProjectAllowList()).toEqual(['alpha', 'beta']);
    });

    test('カンマだけなら undefined を返すこと', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = ',,,';
      expect(getProjectAllowList()).toBeUndefined();
    });

    test('呼び出しごとに環境変数を読み直すこと', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha';
      expect(getProjectAllowList()).toEqual(['alpha']);
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'beta';
      expect(getProjectAllowList()).toEqual(['beta']);
    });
  });

  describe('isProjectAllowed', () => {
    test('未設定ならどのプロジェクトも許可されること（後方互換）', () => {
      delete process.env.COSENSE_PROJECT_ALLOW_LIST;
      expect(isProjectAllowed('anything', 'default-project')).toBe(true);
    });

    test('リストに含まれるプロジェクトを許可すること', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha,beta';
      expect(isProjectAllowed('beta', 'default-project')).toBe(true);
    });

    test('リストに無いプロジェクトを拒否すること', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha,beta';
      expect(isProjectAllowed('gamma', 'default-project')).toBe(false);
    });

    test('既定プロジェクトはリストに書かれていなくても許可されること', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha';
      expect(isProjectAllowed('default-project', 'default-project')).toBe(true);
    });

    test('大文字小文字を区別すること', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha';
      expect(isProjectAllowed('Alpha', 'default-project')).toBe(false);
    });

    test('既定プロジェクトが未指定でもリストだけで判定できること', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha';
      expect(isProjectAllowed('alpha', undefined)).toBe(true);
      expect(isProjectAllowed('beta', undefined)).toBe(false);
    });
  });

  describe('projectNotAllowedMessage', () => {
    test('許可済みプロジェクトの一覧を含むこと', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha,beta';
      const message = projectNotAllowedMessage('gamma', 'default-project');
      expect(message).toContain("Project 'gamma' is not allowed");
      expect(message).toContain('COSENSE_PROJECT_ALLOW_LIST');
      expect(message).toContain('default-project, alpha, beta');
    });

    test('暗黙に許可される既定プロジェクトを一覧に含めること', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha';
      expect(projectNotAllowedMessage('gamma', 'default-project')).toContain('default-project');
    });

    test('既定プロジェクトがリストにもある場合に重複させないこと', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'default-project,alpha';
      expect(projectNotAllowedMessage('gamma', 'default-project'))
        .toContain('Permitted projects: default-project, alpha');
    });
  });

  describe('checkProjectAllowed', () => {
    test('許可されていれば undefined を返すこと', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha';
      expect(checkProjectAllowed('alpha', 'default-project')).toBeUndefined();
    });

    test('未設定なら undefined を返すこと', () => {
      delete process.env.COSENSE_PROJECT_ALLOW_LIST;
      expect(checkProjectAllowed('anything', 'default-project')).toBeUndefined();
    });

    test('拒否時はメッセージ文字列を返すこと（例外は投げない）', () => {
      process.env.COSENSE_PROJECT_ALLOW_LIST = 'alpha';
      expect(checkProjectAllowed('gamma', 'default-project'))
        .toBe(projectNotAllowedMessage('gamma', 'default-project'));
    });
  });
});
