const COUNTRIES = [
  ['Netherlands', ['netherlands', 'nederland']],
  ['France', ['france']],
  ['Belgium', ['belgium', 'belgique', 'belgië']],
  ['Denmark', ['denmark', 'danmark']],
  ['Luxembourg', ['luxembourg']],
  ['Sweden', ['sweden', 'sverige']],
];

function text(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.name ?? value.label ?? value.code ?? '';
  return '';
}

/** Resolve only the configured priority-country names; unknown stays unknown. */
export function inferDailyCandidateCountry(candidate = {}) {
  const explicit = text(candidate.country ?? candidate.country_name ?? candidate.countryName).trim();
  const values = [explicit, text(candidate.location), text(candidate.locations)].filter(Boolean).join(' ').toLocaleLowerCase('en');
  for (const [country, aliases] of COUNTRIES) {
    if (aliases.some((alias) => new RegExp(`(?:^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`, 'i').test(values))) return country;
  }
  return null;
}
