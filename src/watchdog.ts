export function watchdog(secondsTimeout: number, service: string) {
  const signals = ['SIGTERM', 'SIGINT'];
  signals.forEach((signal) => {
    process.on(signal, () => {
      console.log(
        `[Watchdog] (service=${service}) Intercepted ${signal}. Initializing safety fallback timer.`,
      );

      // Force exit if NestJS takes longer than 15 seconds to shut down
      setTimeout(() => {
        console.error(
          `[Watchdog] CRITICAL: Shutdown hung! Forcing termination via process.exit.`,
        );
        process.exit(1);
      }, secondsTimeout * 1000).unref(); // .unref() ensures this timer won't keep the process alive itself
    });
  });
}
