/**
 * 招待の発行と消費。
 *
 * 「短い合言葉でよい」根拠が使い捨て・期限・レート制限の3点なので、
 * そのうちサーバー側で守る2つ（使い捨て・期限）をここで固定する。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InviteError,
  InviteStore,
  generateInviteCode,
  normalizeInviteCode,
} from '../../auth/invites.js';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cosense-invites-')), 'invites.json');
}

const PARAMS = { userId: 'friend', projects: ['shared'], enableDelete: false };

describe('招待コード', () => {
  it('読み違えやすい字を含まない', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[a-z2-9]{3}-[a-z2-9]{3}-[a-z2-9]{3}$/);
      // 0/O/1/l/i は口頭でも手書きでも間違えられる
      expect(code).not.toMatch(/[01lio]/);
    }
  });

  it('表記の揺れを吸収する（手で書き写す前提なので）', () => {
    expect(normalizeInviteCode('KFP-7Q2-XM4')).toBe('kfp7q2xm4');
    expect(normalizeInviteCode('kfp 7q2 xm4')).toBe('kfp7q2xm4');
    expect(normalizeInviteCode('kfp7q2xm4')).toBe('kfp7q2xm4');
  });

  it('毎回違うコードが出る', () => {
    const codes = new Set(Array.from({ length: 200 }, generateInviteCode));
    expect(codes.size).toBe(200);
  });
});

describe('InviteStore', () => {
  it('発行した合言葉で引ける。大文字やハイフン無しでも通る', () => {
    const store = new InviteStore();
    const { code, invite } = store.create(PARAMS);

    expect(store.find(code)?.id).toBe(invite.id);
    expect(store.find(code.toUpperCase())?.id).toBe(invite.id);
    expect(store.find(code.replace(/-/g, ''))?.id).toBe(invite.id);
    expect(store.find('aaa-bbb-ccc')).toBeUndefined();
  });

  it('合言葉の平文は保存しない', () => {
    const path = tempPath();
    const store = new InviteStore(path);
    const { code } = store.create(PARAMS);

    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toContain(normalizeInviteCode(code));
    expect(raw).toContain('codeHash');
  });

  it('使い捨て。消費した合言葉は二度と通らない', () => {
    const store = new InviteStore();
    const { code, invite } = store.create(PARAMS);

    store.consume(invite.id);
    expect(store.find(code)).toBeUndefined();
    expect(() => store.consume(invite.id)).toThrow(InviteError);
  });

  it('引いただけでは消費しない（入力ミス1回で招待を失わない）', () => {
    const store = new InviteStore();
    const { code } = store.create(PARAMS);

    expect(store.find(code)).toBeDefined();
    // 登録の途中で失敗しても、もう一度やり直せる
    expect(store.find(code)).toBeDefined();
  });

  it('期限切れは引けず、未使用なら掃除される', () => {
    const path = tempPath();
    const store = new InviteStore(path);
    const { code } = store.create({ ...PARAMS, ttlSec: -1 });

    expect(store.find(code)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it('使用済みの記録は残す（誰がいつ入ったかを辿るため）', () => {
    const store = new InviteStore();
    const { invite } = store.create(PARAMS);
    store.consume(invite.id);

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.usedAt).toBeDefined();
    expect(listed[0]!.userId).toBe('friend');
  });

  it('未使用の招待は取り消せる。使用済みは取り消せない', () => {
    const store = new InviteStore();
    const { code, invite } = store.create(PARAMS);

    expect(store.revoke(invite.id)).toBe(true);
    expect(store.find(code)).toBeUndefined();

    const second = store.create(PARAMS);
    store.consume(second.invite.id);
    expect(store.revoke(second.invite.id)).toBe(false);
  });

  it('権限は発行時に固定される（あとから合言葉側では変えられない）', () => {
    const store = new InviteStore();
    const { code } = store.create({ userId: 'friend', projects: ['shared', 'notes'], enableDelete: true });

    const found = store.find(code)!;
    expect(found.projects).toEqual(['shared', 'notes']);
    expect(found.enableDelete).toBe(true);
  });

  it('再起動をまたいでも有効', () => {
    const path = tempPath();
    const { code } = new InviteStore(path).create(PARAMS);
    expect(new InviteStore(path).find(code)?.userId).toBe('friend');
  });
});
