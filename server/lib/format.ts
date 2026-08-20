/** Quantity display: trims trailing zeros without float conversion. */
export function formatQuantityForApi(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const [int = '0', dec = ''] = value.split('.');
  const trimmed = dec.replace(/0+$/, '');
  return trimmed ? `${int}.${trimmed}` : int;
}
