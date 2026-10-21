import { credentialHeaders, resolveCredential, withServerToken } from '@/utils/auth.js';

describe('resolveCredential', () => {
  afterEach(() => {
    delete process.env.COSENSE_MCP_PAT;
  });

  test('何も無ければ undefined を返すこと', () => {
    expect(resolveCredential()).toBeUndefined();
  });

  test('SID だけなら SID を返すこと', () => {
    expect(resolveCredential('sid-value')).toEqual({ type: 'sid', value: 'sid-value' });
  });

  test('SID が無ければ COSENSE_MCP_PAT を使うこと', () => {
    process.env.COSENSE_MCP_PAT = 'pat-value';
    expect(resolveCredential()).toEqual({ type: 'personalAccessToken', value: 'pat-value' });
  });

  test('両方あれば SID を使うこと（SID で使っている環境を変えない）', () => {
    process.env.COSENSE_MCP_PAT = 'pat-value';
    expect(resolveCredential('sid-value')).toEqual({ type: 'sid', value: 'sid-value' });
  });

  test('空白だけの COSENSE_MCP_PAT は無視すること', () => {
    process.env.COSENSE_MCP_PAT = '   ';
    expect(resolveCredential()).toBeUndefined();
  });

  test('公式 CLI の COSENSE_PAT は読まないこと', () => {
    process.env.COSENSE_PAT = 'cli-token';
    try {
      expect(resolveCredential()).toBeUndefined();
    } finally {
      delete process.env.COSENSE_PAT;
    }
  });

  test('cs_ で始まる COSENSE_MCP_PAT は Service Account として扱うこと', () => {
    process.env.COSENSE_MCP_PAT = 'cs_key';
    expect(resolveCredential()).toEqual({ type: 'serviceAccount', value: 'cs_key' });
  });
});

describe('credentialHeaders', () => {
  test('資格情報の種類ごとのヘッダを返すこと', () => {
    expect(credentialHeaders({ type: 'personalAccessToken', value: 't' })).toEqual({ 'x-personal-access-token': 't' });
    expect(credentialHeaders({ type: 'serviceAccount', value: 'k' })).toEqual({ 'x-service-account-access-key': 'k' });
    expect(credentialHeaders({ type: 'sid', value: 's' })).toEqual({ Cookie: 'connect.sid=s' });
    expect(credentialHeaders(undefined)).toEqual({});
  });
});

describe('withServerToken', () => {
  afterEach(() => {
    delete process.env.COSENSE_MCP_PAT;
  });

  test('許可しない間は COSENSE_MCP_PAT に落ちないこと', async () => {
    process.env.COSENSE_MCP_PAT = 'operator-pat';
    // 非同期をまたいでも効く（ハンドラは await を挟む）
    const inside = await withServerToken(false, async () => {
      await Promise.resolve();
      return resolveCredential();
    });
    expect(inside).toBeUndefined();
  });

  test('許可しなくても、本人の SID は使えること', () => {
    process.env.COSENSE_MCP_PAT = 'operator-pat';
    expect(withServerToken(false, () => resolveCredential('own-sid'))).toEqual({ type: 'sid', value: 'own-sid' });
  });

  test('許可していれば従来どおり PAT を使うこと。外へ出れば元に戻ること', () => {
    process.env.COSENSE_MCP_PAT = 'operator-pat';
    expect(withServerToken(true, () => resolveCredential())).toEqual({ type: 'personalAccessToken', value: 'operator-pat' });
    withServerToken(false, () => undefined);
    expect(resolveCredential()).toEqual({ type: 'personalAccessToken', value: 'operator-pat' });
  });
});
