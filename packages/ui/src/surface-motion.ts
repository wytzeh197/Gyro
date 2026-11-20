/** Closing takes 80% of the opening time, using the surface's motion preference. */
export function surfaceExitRate(element: HTMLElement): number {
  const factor = Number.parseFloat(
    getComputedStyle(element).getPropertyValue("--gyro-exit-motion-factor"),
  );
  return factor > 0 ? 1 / factor : 1.25;
}

/** Change direction without assigning currentTime or replacing the entrance. */
export function playSurfaceTimeline(animation: Animation, rate: number) {
  animation.updatePlaybackRate(rate);
  animation.play();
}
