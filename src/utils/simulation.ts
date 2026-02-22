export function simulateError(prob = 0.5, after: string = '') {
  if (Math.random() < prob) {
    console.error(
      `[ERROR] Unexpected error happened${after ? ` after ${after}` : ''}`,
    );
    throw new Error(
      `Unexpected error happened${after ? ` after ${after}` : ''}`,
    );
  }
}
