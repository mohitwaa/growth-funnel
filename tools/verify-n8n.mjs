/**
 * Executes the n8n workflow's Code nodes against a real captured payload.
 * Run from the repo root:  node tools/verify-n8n.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const wf = JSON.parse(readFileSync(process.env.WF ?? 'n8n/workflow.json','utf8'));
const payload = JSON.parse(readFileSync(process.env.PAYLOAD ?? 'tools/fixtures-lead.json','utf8'));
const code = (n) => wf.nodes.find(x => x.name === n).parameters.jsCode;
const vars = { AIRTABLE_BASE:'appat7SRcUPM2Vc20', META_PIXEL_ID:'1605755971334134', META_TEST_EVENT_CODE:'TEST12345' };
const P=[]; const t=(n,ok,d)=>P.push(`${ok?'PASS':'FAIL'}  ${n}  ::  ${d}`);

// Node 1
const $input1 = { first: () => ({ json: { body: payload, headers: { 'x-forwarded-for': '203.0.113.55, 10.0.0.1' } } }) };
const mapped = new Function('$input','$vars','require', code('Map to Airtable schema'))($input1, vars, require)[0].json;

t('N1 lead_key = session_id', mapped.leadKey === payload.identity.session_id, mapped.leadKey);
t('N1 idempotency_key = event id', mapped.fields.idempotency_key === payload.event.id, mapped.fields.idempotency_key);
t('N1 grade A -> a', mapped.fields.grade === 'a', mapped.fields.grade);
t('N1 value_usd', mapped.fields.value_usd === 72, mapped.fields.value_usd);
t('N1 phase complete', mapped.fields.phase === 'complete', mapped.fields.phase);
t('N1 status qualified', mapped.fields.status === 'qualified', mapped.fields.status);
t('N1 client_ip from x-forwarded-for', mapped.fields.client_ip === '203.0.113.55', mapped.fields.client_ip);
t('N1 channel from click id', mapped.fields.channel === 'paid_social_meta' && mapped.fields.channel_decided_by === 'fbclid', `${mapped.fields.channel}/${mapped.fields.channel_decided_by}`);
t('N1 phone E.164 with +', mapped.fields.phone_e164 === '+13125550144', mapped.fields.phone_e164);
t('N1 consent sha256 (64 hex)', /^[0-9a-f]{64}$/.test(mapped.fields.consent_text_sha256||''), (mapped.fields.consent_text_sha256||'').slice(0,16)+'...');
t('N1 answers_json present', !!mapped.fields.answers_json, 'yes');
t('N1 viewport parsed', mapped.fields.viewport_w === 929 && mapped.fields.viewport_h === 861, `${mapped.fields.viewport_w}x${mapped.fields.viewport_h}`);
t('N1 no null fields sent', !Object.values(mapped.fields).some(v => v === null), Object.keys(mapped.fields).length + ' fields');

// Node 2 — fresh
const guardFn = code('High-water guard');
const runGuard = (m, rank, step) => new Function('$input','$', guardFn)(
  { first: () => ({ json: { records: rank ? [{ fields:{ highest_event_rank: rank, furthest_step: step } }] : [] } }) },
  () => ({ first: () => ({ json: m }) })
)[0].json;

const fresh = runGuard(mapped, 0, 0);
t('N2 fresh lead keeps all fields', fresh.fields.phase === 'complete' && fresh.fields.value_usd === 72, 'intact');

const regress = runGuard({ ...mapped, rank: 1, fields: { ...mapped.fields, highest_event_rank: 1, value_usd: 0.5, phase: 'partial' } }, 4, 7);
t('N2 regressive event stripped', !('phase' in regress.fields) && !('value_usd' in regress.fields), 'phase+value_usd removed');
t('N2 lead_key survives strip', regress.fields.lead_key === mapped.leadKey, 'kept');

// Node 3 — CAPI body
const capi = new Function('$','$vars','require', code('Hash PII → CAPI body'))(
  () => ({ first: () => ({ json: fresh }) }), vars, require
)[0].json;
const ud = capi.body.data[0].user_data;
const { createHash } = require('crypto');
const sha = (v) => createHash('sha256').update(v).digest('hex');

t('N3 event_id matches Pixel eventID', capi.body.data[0].event_id === payload.event.id, capi.body.data[0].event_id);
t('N3 event_name = Lead', capi.body.data[0].event_name === 'Lead', capi.body.data[0].event_name);
t('N3 em hashed correctly', ud.em?.[0] === sha('n8n.flowtest@example.com'), (ud.em?.[0]||'').slice(0,16)+'...');
t('N3 ph hashed correctly', ud.ph?.[0] === sha('13125550144'), (ud.ph?.[0]||'').slice(0,16)+'...');
t('N3 fbp sent UNhashed', ud.fbp === payload.identity.fbp, ud.fbp);
t('N3 fbc sent UNhashed', ud.fbc === payload.identity.fbc, ud.fbc);
t('N3 client_ip from header not client', ud.client_ip_address === '203.0.113.55', ud.client_ip_address);
t('N3 value + currency', capi.body.data[0].custom_data.value === 72 && capi.body.data[0].custom_data.currency === 'USD', '72 USD');
t('N3 NO raw answers leak to Meta', !JSON.stringify(capi.body).includes('condition_duration'), 'clean');
t('N3 NO email in cleartext to Meta', !JSON.stringify(capi.body).includes('n8n.flowtest@example.com'), 'clean');
t('N3 no test_event_code by default (live)', !capi.body.test_event_code, 'absent - set TEST_EVENT_CODE in the node to verify');
t('N3 identifier_count', capi.identifier_count === 10, capi.identifier_count);

console.log(P.join('\n'));
console.log('\n' + P.filter(x=>x.startsWith('PASS')).length + '/' + P.length + ' passed');
