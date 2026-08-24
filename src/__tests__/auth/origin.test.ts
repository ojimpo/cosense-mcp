import { OriginValidator } from '../../auth/origin.js';

const SELF = 'https://cosense-mcp.example.com';

describe('OriginValidator', () => {
  describe('未設定（report モード）', () => {
    const validator = new OriginValidator(undefined, SELF);

    it('policyはreport', () => {
      expect(validator.policy).toBe('report');
    });

    it('Originが無いリクエストは通す（サーバー間呼び出し）', () => {
      // Claude.ai / ChatGPT のサーバー間呼び出しは Origin を送らない。
      // ここで弾くと本番が全滅する。
      expect(validator.check(undefined).allowed).toBe(true);
    });

    it('未知のOriginでも通すが、理由は記録する', () => {
      const verdict = validator.check('https://evil.example.com');
      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toContain('disallowed Origin');
    });

    it('既知のクライアントのOriginは理由なしで通す', () => {
      expect(validator.check('https://claude.ai')).toEqual({ allowed: true });
      expect(validator.check('https://chatgpt.com')).toEqual({ allowed: true });
    });

    it('自分自身のOriginを通す', () => {
      expect(validator.check(SELF)).toEqual({ allowed: true });
    });
  });

  describe('明示設定あり（enforce モード）', () => {
    const validator = new OriginValidator(['https://claude.ai'], SELF);

    it('policyはenforce', () => {
      expect(validator.policy).toBe('enforce');
    });

    it('許可リスト外を拒否する', () => {
      const verdict = validator.check('https://evil.example.com');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('disallowed Origin');
    });

    it('リストに無ければ既定の既知クライアントでも拒否する', () => {
      // 明示設定は既定リストを置き換える（足すのではない）
      expect(validator.check('https://chatgpt.com').allowed).toBe(false);
    });

    it('許可リスト内は通す', () => {
      expect(validator.check('https://claude.ai').allowed).toBe(true);
    });

    it('Originが無いリクエストは通す', () => {
      expect(validator.check(undefined).allowed).toBe(true);
    });

    it('壊れたOriginを拒否する', () => {
      expect(validator.check('not-a-url').allowed).toBe(false);
    });
  });

  describe('loopback', () => {
    it('ポートが変わるMCP Inspector等のためにホスト単位で許す', () => {
      const validator = new OriginValidator(['https://claude.ai'], SELF);
      expect(validator.check('http://localhost:6274').allowed).toBe(true);
      expect(validator.check('http://127.0.0.1:31337').allowed).toBe(true);
    });
  });
});
