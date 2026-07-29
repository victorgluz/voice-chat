// Atualização de DNS na Cloudflare no deploy (ex.: apontar um CNAME para o
// destino atual quando o app sobe).
//
// É OPCIONAL: se CF_API_TOKEN não estiver definido no ambiente, a rotina é
// ignorada — o servidor sobe normalmente sem tocar no DNS. Isso permite rodar
// em LAN/localhost sem nenhuma configuração da Cloudflare.

import { config } from '../../config/index.js';

const API = 'https://api.cloudflare.com/client/v4';

async function cf(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = json.errors?.map((e) => e.message).join('; ') || res.statusText;
    throw new Error(msg);
  }
  return json.result;
}

/**
 * Faz upsert do registro DNS configurado por variáveis de ambiente:
 * PATCH se o registro já existe, POST (cria) caso contrário.
 * Nunca derruba o boot: qualquer erro é apenas logado.
 */
export async function updateDnsRecord() {
  const token = process.env.CF_API_TOKEN;

  // Sem token → ignora o patch do CNAME (comportamento pedido).
  if (!token) return;

  const recordName = process.env.CF_RECORD_NAME;
  // Vazio → usa o IP que o servidor anuncia na LAN (a linha "→ Rede:" do boot).
  const content = process.env.CF_RECORD_CONTENT?.trim() || config.http.lanIp;
  const type = process.env.CF_RECORD_TYPE || 'CNAME';
  const proxied = process.env.CF_RECORD_PROXIED !== 'false';
  const zoneName = process.env.CF_ZONE_NAME;
  let zoneId = process.env.CF_ZONE_ID;

  if (!recordName || (!zoneId && !zoneName)) {
    console.warn(
      '  ⚠️  Cloudflare: token presente, mas falta config ' +
        '(CF_ZONE_ID/CF_ZONE_NAME e CF_RECORD_NAME). DNS não atualizado.'
    );
    return;
  }

  try {
    if (!zoneId) {
      const zones = await cf(`/zones?name=${encodeURIComponent(zoneName)}`, { token });
      zoneId = zones?.[0]?.id;
      if (!zoneId) throw new Error(`zona "${zoneName}" não encontrada`);
    }

    const records = await cf(
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(recordName)}`,
      { token }
    );
    const record = records?.[0];
    const payload = { type, name: recordName, content, ttl: 1, proxied };

    if (record) {
      await cf(`/zones/${zoneId}/dns_records/${record.id}`, {
        token,
        method: 'PATCH',
        body: payload,
      });
      console.log(`  ✅  Cloudflare: ${type} ${recordName} → ${content} (atualizado).`);
    } else {
      await cf(`/zones/${zoneId}/dns_records`, { token, method: 'POST', body: payload });
      console.log(`  ✅  Cloudflare: ${type} ${recordName} → ${content} (criado).`);
    }
  } catch (err) {
    console.error(`  ⚠️  Cloudflare: falha ao atualizar DNS — ${err.message}`);
  }
}
