export function formatUSD(amount: number, inCent = false) {
  const usdFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  });

  return usdFormatter.format(inCent ? amount / 100 : amount);
}

export function formatError(error: Error) {
  return `ERROR: ${error.name}
  Cause: ${error.cause}
  Message: ${error.message}
  Traceback:
  ${error.stack}`;
}
