export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function unix() {
  const timestamp = Math.floor(Date.now() / 1000);
  return timestamp;
}
