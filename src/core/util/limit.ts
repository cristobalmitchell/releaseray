/**
 * Maps over items with at most `limit` calls in flight, keeping input order.
 *
 * @param items - Inputs
 * @param limit - Most concurrent calls (at least 1)
 * @param fn - Async mapper
 * @returns Results in input order
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
