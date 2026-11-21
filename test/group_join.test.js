const assert = require('assert');
const api = require('../lib/group_control_api');

const { groupJoin, parseInviteCode } = api;

let pass = 0;
let fail = 0;

function ok(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') throw new Error('ok() tidak menerima async, pakai okAsync()');
        pass++;
        console.log(`ok   ${name}`);
    } catch (e) {
        fail++;
        console.log(`FAIL ${name}: ${e.message}`);
    }
}

async function okAsync(name, fn) {
    try {
        await fn();
        pass++;
        console.log(`ok   ${name}`);
    } catch (e) {
        fail++;
        console.log(`FAIL ${name}: ${e.message}`);
    }
}

function expectCode(fn, code) {
    try {
        fn();
    } catch (e) {
        assert.strictEqual(e.code, code, `harus ${code}, dapat ${e.code}`);
        return;
    }
    throw new Error(`harus melempar ${code}, tapi tidak`);
}

async function expectCodeAsync(fn, code) {
    try {
        await fn();
    } catch (e) {
        assert.strictEqual(e.code, code, `harus ${code}, dapat ${e.code}`);
        return;
    }
    throw new Error(`harus melempar ${code}, tapi tidak`);
}


console.log('[1] parseInviteCode');

ok('URL penuh dengan query', () => {
    assert.strictEqual(
        parseInviteCode('https://chat.whatsapp.com/E2g82JylzL7HxC3URNULXm?s=cl&p=a&iam=2'),
        'E2g82JylzL7HxC3URNULXm'
    );
});

ok('URL bentuk /invite/CODE', () => {
    assert.strictEqual(parseInviteCode('https://chat.whatsapp.com/invite/AbCdEfGh123456'), 'AbCdEfGh123456');
});

ok('URL tanpa skema', () => {
    assert.strictEqual(parseInviteCode('chat.whatsapp.com/AbCdEfGh123456'), 'AbCdEfGh123456');
});

ok('kode mentah + spasi di ujung', () => {
    assert.strictEqual(parseInviteCode('   AbCdEfGh123456   '), 'AbCdEfGh123456');
});

ok('fragment dibuang', () => {
    assert.strictEqual(parseInviteCode('https://chat.whatsapp.com/AbCdEfGh123456#foo'), 'AbCdEfGh123456');
});

ok('kosong -> NO_LINK', () => expectCode(() => parseInviteCode(''), 'NO_LINK'));
ok('null -> NO_LINK', () => expectCode(() => parseInviteCode(null), 'NO_LINK'));
ok('domain lain -> INVALID_LINK', () => expectCode(() => parseInviteCode('https://example.com/AbCdEfGh123456'), 'INVALID_LINK'));
ok('URL tanpa kode -> INVALID_LINK', () => expectCode(() => parseInviteCode('https://chat.whatsapp.com/'), 'INVALID_LINK'));
ok('kode kepanjangan -> INVALID_LINK', () => expectCode(() => parseInviteCode('A'.repeat(60)), 'INVALID_LINK'));


function fakeSock({ info, metaBefore = null, metaAfter = null, acceptError = null, acceptResult = null }) {
    let metaCalls = 0;
    return {
        calls: { accept: 0, getInfo: 0, metadata: 0 },
        async groupGetInviteInfo() {
            this.calls.getInfo++;
            if (info instanceof Error) throw info;
            return info;
        },
        async groupAcceptInvite(code) {
            this.calls.accept++;
            this.acceptedCode = code;
            if (acceptError) throw acceptError;
            return acceptResult;
        },
        async groupMetadata() {
            this.calls.metadata++;
            metaCalls++;
            
            if (metaCalls === 1) {
                if (metaBefore) return metaBefore;
                const err = new Error('not-a-participant');
                err.code = 403;
                throw err;
            }
            if (metaAfter) return metaAfter;
            const err = new Error('not-a-participant');
            err.code = 403;
            throw err;
        }
    };
}

const META = { id: '120363431433775024@g.us', subject: 'Kks', participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], announce: false };

(async () => {
    
    console.log('[2] join grup terbuka');
    await okAsync('joined=true + metadata hasil join dipakai', async () => {
        const sock = fakeSock({
            info: { id: META.id, subject: 'Kks', size: 3, joinApprovalMode: false, announce: false },
            metaAfter: META
        });
        const r = await groupJoin(sock, 'https://chat.whatsapp.com/E2g82JylzL7HxC3URNULXm?s=cl&p=a&iam=2');
        assert.strictEqual(r.joined, true);
        assert.strictEqual(r.pending, false);
        assert.strictEqual(r.alreadyMember, undefined);
        assert.strictEqual(r.jid, META.id);
        assert.strictEqual(r.name, 'Kks');
        assert.strictEqual(r.participants, 3);
        assert.strictEqual(r.inviteCode, 'E2g82JylzL7HxC3URNULXm');
        assert.strictEqual(sock.calls.accept, 1);
        assert.strictEqual(sock.acceptedCode, 'E2g82JylzL7HxC3URNULXm');
    });

    
    console.log('[3] join grup butuh approval');
    await okAsync('pending=true, joined=false, bukan diklaim sukses', async () => {
        const sock = fakeSock({
            info: { id: '120363400000000001@g.us', subject: 'Grup Tertutup', size: 120, joinApprovalMode: true }
        });
        const r = await groupJoin(sock, 'AbCdEfGh123456');
        assert.strictEqual(r.joined, false);
        assert.strictEqual(r.pending, true);
        assert.strictEqual(r.approvalRequired, true);
        assert.strictEqual(r.jid, '120363400000000001@g.us');
        assert.strictEqual(r.name, 'Grup Tertutup');
        assert.ok(/persetujuan admin/i.test(r.note), 'note harus menyebut persetujuan admin');
        assert.strictEqual(sock.calls.accept, 1);
    });

    
    console.log('[4] sudah anggota');
    await okAsync('alreadyMember=true, groupAcceptInvite tidak dipanggil', async () => {
        const sock = fakeSock({
            info: { id: META.id, subject: 'Kks', size: 3, joinApprovalMode: false },
            metaBefore: META
        });
        const r = await groupJoin(sock, 'AbCdEfGh123456');
        assert.strictEqual(r.joined, true);
        assert.strictEqual(r.alreadyMember, true);
        assert.strictEqual(sock.calls.accept, 0);
    });

    
    console.log('[5] undangan tidak valid');
    await okAsync('groupGetInviteInfo error -> INVITE_INVALID', async () => {
        const sock = fakeSock({ info: new Error('item-not-found') });
        await expectCodeAsync(() => groupJoin(sock, 'AbCdEfGh123456'), 'INVITE_INVALID');
        assert.strictEqual(sock.calls.accept, 0, 'tidak boleh coba join kalau undangan sudah mati');
    });

    
    console.log('[6] join gagal');
    await okAsync('accept error tanpa approval -> JOIN_FAILED', async () => {
        const sock = fakeSock({
            info: { id: META.id, subject: 'Kks', size: 3, joinApprovalMode: false },
            acceptError: new Error('group-full')
        });
        await expectCodeAsync(() => groupJoin(sock, 'AbCdEfGh123456'), 'JOIN_FAILED');
    });

    
    console.log('[7] link invalid tidak menyentuh socket');
    await okAsync('INVALID_LINK sebelum panggil socket', async () => {
        const sock = fakeSock({ info: { id: META.id } });
        await expectCodeAsync(() => groupJoin(sock, 'https://example.com/abc'), 'INVALID_LINK');
        assert.strictEqual(sock.calls.getInfo, 0);
        assert.strictEqual(sock.calls.accept, 0);
    });

    console.log(`\n${pass} ok, ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
