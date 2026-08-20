/** String-only money formatting for PDFs (no binary floats, ever). */
export function formatMoneyForPdf(value: string, currency: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const negative = value.startsWith('-');
  const [rawInt = '0', rawDec = ''] = (negative ? value.slice(1) : value).split('.');
  const grouped = rawInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimals = (rawDec + '00').slice(0, 2);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${negative ? '-' : ''}${symbol}${grouped}.${decimals}`;
}
