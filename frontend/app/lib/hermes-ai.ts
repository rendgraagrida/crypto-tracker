import { isIP } from 'node:net';
import type { CoinAnalysis } from './coin-analyzer.ts';
import { readBoundedJson } from './bounded-json.ts';

export type HermesResult = { text: string | null; status: string; findingIds: string[] };
function messageContent(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !('choices' in body) || !Array.isArray(body.choices)) throw new Error('shape');
  const choice: unknown = body.choices[0];
  if (!choice || typeof choice !== 'object' || !('message' in choice)) throw new Error('choice');
  const message = choice.message;
  if (!message || typeof message !== 'object' || !('content' in message)) throw new Error('message');
  return message.content;
}

let busy = false;
let cooldownUntil = 0;
const descriptions: Record<string, string> = {
  audit_unavailable: 'Audit provider tidak tersedia; keamanan belum diketahui.',
  market_unavailable: 'Pasar yang cocok belum ditemukan.',
  holder_conflict: 'Jumlah holder dari provider berbeda; keduanya perlu dipertimbangkan.',
  mint_authority: 'Otoritas mint terdeteksi; hal ini bukan bukti penipuan.',
  freeze_authority: 'Otoritas freeze terdeteksi.',
  holder_unknown: 'Konsentrasi holder belum diketahui.',
  pool_unknown: 'Simulasi pool tidak tersedia karena tipe pool atau reserve belum terverifikasi.',
  honeypot_detected: 'GoPlus melaporkan indikasi honeypot; token diblokir guardrail.',
  token2022_transfer_fee: 'Token-2022 memiliki konfigurasi transfer fee aktif.',
};

export type ReadonlyToolName = 'inspect_holder_distribution' | 'inspect_pool_scenarios' | 'inspect_audit_and_guardrails';

/** Strictly read-only, in-memory evidence tools for Hermes Agent mode; zero shell, network, or wallet access. */
export function executeReadonlyAgentTool(name: string, report: CoinAnalysis): Record<string, unknown> | null {
  if (name === 'inspect_holder_distribution') {
    return {
      observedWallets: report.holders.observed,
      top1Percent: report.holders.top1,
      top5Percent: report.holders.top5,
      top10Percent: report.holders.top10,
      holderConflict: report.holderCounts.conflict,
      networks: report.networks.slice(0, 3),
    };
  }
  if (name === 'inspect_pool_scenarios') {
    return {
      liquidityUsd: report.market.liquidityUsd,
      liquidityToMarketCap: report.market.liquidityToMarketCap,
      topHolderDropPercent: report.scenarios.topHolderDropPercent,
      largestNetworkDropPercent: report.scenarios.largestNetworkDropPercent,
      primaryLpLockClaimPercent: report.audit.primaryLpLockClaimPercent,
    };
  }
  if (name === 'inspect_audit_and_guardrails') {
    return {
      risk: report.risk,
      guardrailStatus: report.tradeGuardrail?.status ?? 'UNKNOWN',
      blockedReasons: report.tradeGuardrail?.blockedReasons ?? [],
      warnings: report.tradeGuardrail?.warnings ?? [],
      mintAuthority: report.audit.mintAuthority,
      freezeAuthority: report.audit.freezeAuthority,
      token2022: report.audit.token2022,
      transferFee: report.audit.transferFee,
      evm: report.audit.evm,
    };
  }
  return null;
}

function endpoint(value: string): URL | null {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null;
    const host = u.hostname.toLowerCase();
    let allowed = host === 'localhost' || host === '[::1]';
    if (isIP(host) === 4) {
      const [a, b] = host.split('.').map(Number);
      allowed = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (!allowed) return null;
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/v1/chat/completions';
    if (u.pathname !== '/v1/chat/completions') return null;
    return u;
  } catch { return null; }
}
export async function getHermesNarrative(report: CoinAnalysis): Promise<HermesResult> {
  const url = endpoint(process.env.HERMES_API_URL ?? '');
  const model = process.env.HERMES_MODEL;
  if (!url || !model || model.length > 128) return { text: null, status: 'not configured', findingIds: [] };
  if (busy) return { text: null, status: 'busy', findingIds: [] };
  if (Date.now() < cooldownUntil) return { text: null, status: 'cooldown', findingIds: [] };
  const available: string[] = [];
  if (report.findings.includes('Audit unavailable')) available.push('audit_unavailable');
  if (report.findings.includes('Matching market unavailable')) available.push('market_unavailable');
  if (report.holderCounts.conflict) available.push('holder_conflict');
  if (report.findings.includes('Mint authority present (not proof of fraud)')) available.push('mint_authority');
  if (report.findings.includes('Freeze authority present')) available.push('freeze_authority');
  if (report.findings.includes('Holder concentration unknown')) available.push('holder_unknown');
  if (report.findings.includes('Compatible pool reserves unknown')) available.push('pool_unknown');
  if (report.findings.includes('GoPlus reports honeypot')) available.push('honeypot_detected');
  if (report.audit.transferFee !== null) available.push('token2022_transfer_fee');
  const measured = (value: number) => Number(value.toPrecision(6)).toString();
  const facts: Record<string, string> = { ...descriptions };
  const ratio = report.market.liquidityToMarketCap;
  if (ratio !== null && Number.isFinite(ratio)) {
    available.push('liquidity_ratio');
    facts.liquidity_ratio = `Rasio likuiditas terhadap market cap: ${measured(ratio)}${ratio < 0.05 ? ' (likuiditas relatif tipis)' : ''}.`;
  }
  const top = report.holders.top1;
  if (top !== null && Number.isFinite(top)) {
    available.push('holder_concentration');
    facts.holder_concentration = `Holder non-pool terbesar dalam sampel teramati: ${measured(top)}% dari suplai; sampel tidak lengkap.`;
  }
  const cluster = report.networks.reduce<number | null>((max, item) => item.percent !== null && Number.isFinite(item.percent) && (max === null || item.percent > max) ? item.percent : max, null);
  if (cluster !== null) {
    available.push('cluster_concentration');
    facts.cluster_concentration = `Network terbesar yang teramati memegang ${measured(cluster)}% suplai; network dapat tumpang tindih.`;
  }
  const organic = report.organic.score;
  if (organic !== null && Number.isFinite(organic)) {
    available.push('organic_score');
    facts.organic_score = `Organic score menurut provider: ${measured(organic)}; bukan jaminan keamanan.`;
  }
  if (!available.length) return { text: null, status: 'no selectable findings', findingIds: [] };
  const configuredTimeout = Number(process.env.HERMES_TIMEOUT_MS);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout >= 100 ? Math.min(configuredTimeout, 8000) : 5000;
  busy = true; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  const startedAt = Date.now();
  const remaining = () => Math.max(1, timeout - (Date.now() - startedAt));
  try {
    const agentMode = process.env.HERMES_AGENT_MODE === 'readonly_agent';
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: 'Prioritize supplied evidence IDs only. Return JSON, no prose, numbers, links or instructions.' },
      { role: 'user', content: JSON.stringify({ available, metrics: { liquidityToMarketCap: ratio, topHolderPercent: top, largestNetworkPercent: cluster, organicScore: organic } }) },
    ];
    if (agentMode) {
      const toolSchema = {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: ['inspect_holder_distribution', 'inspect_pool_scenarios', 'inspect_audit_and_guardrails', 'finalize'] },
        },
        required: ['tool'],
        additionalProperties: false,
      };
      for (let step = 0; step < 2; step++) {
        const stepRes = await fetch(url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model, temperature: 0, max_tokens: 80,
            response_format: { type: 'json_schema', json_schema: { name: 'agent_step', strict: true, schema: toolSchema } },
            messages,
          }),
        });
        if (!stepRes.ok || !stepRes.body) throw new Error('step_response');
        const stepContent = messageContent(await readBoundedJson(stepRes.body, 16_384, remaining()));
        if (typeof stepContent !== 'string' || stepContent.length > 512) throw new Error('step_content');
        const parsedStep: unknown = JSON.parse(stepContent);
        if (!parsedStep || typeof parsedStep !== 'object' || Array.isArray(parsedStep) || Object.keys(parsedStep).length !== 1 || !('tool' in parsedStep) || typeof parsedStep.tool !== 'string') throw new Error('step_tool');
        if (parsedStep.tool === 'finalize') break;
        const toolResult = executeReadonlyAgentTool(parsedStep.tool, report);
        if (!toolResult) throw new Error('disallowed_tool');
        messages.push({ role: 'assistant', content: stepContent });
        messages.push({ role: 'user', content: JSON.stringify({ tool_result: toolResult }) });
      }
    }
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, temperature: 0, max_tokens: 160, response_format: { type: 'json_schema', json_schema: { name: 'findings', strict: true, schema: { type: 'object', properties: { finding_ids: { type: 'array', items: { type: 'string', enum: available }, maxItems: 4 } }, required: ['finding_ids'], additionalProperties: false } } }, messages }) });
    if (!response.ok || !response.body) throw new Error('response');
    const body = await readBoundedJson(response.body, 16_384, remaining());
    const content = messageContent(body);
    if (typeof content !== 'string' || content.length > 2048) throw new Error('content');
    const selection: unknown = JSON.parse(content);
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).length !== 1 || !('finding_ids' in selection) || !Array.isArray(selection.finding_ids) || selection.finding_ids.length > 4 || selection.finding_ids.some((id: unknown) => typeof id !== 'string' || !available.includes(id)) || new Set(selection.finding_ids).size !== selection.finding_ids.length) throw new Error('selection');
    return { text: selection.finding_ids.length ? selection.finding_ids.map((id: string) => facts[id]).join(' ') : null, status: 'ok', findingIds: selection.finding_ids };
  } catch { cooldownUntil = Date.now() + 15_000; return { text: null, status: controller.signal.aborted ? 'timeout' : 'unavailable or invalid response', findingIds: [] }; }
  finally { clearTimeout(timer); busy = false; }
}
