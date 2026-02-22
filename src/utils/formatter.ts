export function formatUSD(amount: number, inCent = false) {
  const usdFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  });

  return usdFormatter.format(inCent ? amount / 100 : amount);
}
