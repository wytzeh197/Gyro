export async function drain(
  send,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt === 4) throw error;
      await wait(100 * 2 ** attempt);
    }
  }
}
