/**
 * Resolve @menções em um texto contra os usuários cadastrados.
 *
 * Estratégia: testa os nomes mais longos primeiro e "mascara" (apaga) o trecho
 * casado numa cópia do texto, para que um nome que é prefixo de outro
 * ("victor" vs "victor gomes") não seja casado por engano dentro do maior.
 * Casamento é case-insensitive e exige que logo após o nome não venha um
 * caractere de palavra (fronteira), permitindo nomes com espaço.
 */
export function extractMentions(content, allUsers) {
  if (!content || !allUsers?.length) return [];

  let work = content.toLowerCase();
  const mentioned = new Set();
  const byLongest = [...allUsers].sort((a, b) => b.name.length - a.name.length);

  for (const user of byLongest) {
    const name = user.name.toLowerCase().trim();
    if (!name) continue;
    const re = new RegExp('@' + escapeRegExp(name) + '(?![\\w])', 'g');
    let matched = false;
    work = work.replace(re, (m) => {
      matched = true;
      return ' '.repeat(m.length); // mascara para não recasar como prefixo
    });
    if (matched) mentioned.add(user.id);
  }

  return [...mentioned];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
