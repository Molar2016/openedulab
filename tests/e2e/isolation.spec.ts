import { expect, test } from '@playwright/test';
import { SECOND_STATE, shot, TEACHER } from './support';

/**
 * Cross-account isolation in a real browser (B6, R-15).
 *
 * Two genuine accounts in two contexts. Account A favorites an experiment and opens it;
 * account B must see an empty library and identical-looking API answers — no shared rows,
 * no "this exists but is not yours" signal.
 */
const STAGE = 'b6';

test.describe('another ordinary account', () => {
  test('cannot see, remove or infer the first account\'s favorites or history', async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'two contexts, one run');

    const firstContext = await browser.newContext({
      baseURL: 'http://127.0.0.1:3220',
      storageState: 'test-results/e2e/.auth/teacher.json',
    });
    const secondContext = await browser.newContext({
      baseURL: 'http://127.0.0.1:3220',
      storageState: SECOND_STATE,
    });
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();

    try {
      // Account A: favorite + open.
      await first.goto('/experiments/math-functions?lang=en');
      await expect(first.getByTestId('formula')).toHaveText('y = x²');
      const favorite = first.getByTestId('favorite-button');
      if ((await favorite.textContent()) === 'Add to favorites') {
        await favorite.click();
      }
      await expect(favorite).toHaveText('Remove from favorites');

      // Account B: a library of its own, empty.
      await second.goto('/me?lang=zh-CN');
      await expect(second.getByRole('heading', { name: '我的', exact: true })).toBeVisible();
      await expect(second.getByTestId('favorites-empty')).toBeVisible();
      await expect(second.getByTestId('recent-empty')).toBeVisible();
      await shot(second, STAGE, 'isolation-second-account');

      // Account B's API answers its own state, not A's.
      const bFavorites = await second.request.get('/api/me/favorites');
      expect(bFavorites.status()).toBe(200);
      expect((await bFavorites.json()).items).toEqual([]);

      // B removing "the same" favorite is a no-op, and A keeps it. The Origin header is
      // required for a write (the CSRF guard rejects a bare API call with 403).
      const removal = await second.request.delete('/api/me/favorites/math.functions', {
        headers: { origin: 'http://127.0.0.1:3220' },
      });
      expect(removal.status()).toBe(204);

      const aFavorites = await first.request.get('/api/me/favorites');
      const aItems = (await aFavorites.json()) as { items: { experimentId: string }[] };
      expect(aItems.items.map((item) => item.experimentId)).toContain('math.functions');

      // A's display hint is what A sees; B never learns A's identifier.
      await first.goto('/me?lang=en');
      await expect(first.getByTestId('account-block')).toContainText('e***@example.com');
      await expect(first.getByTestId('account-block')).not.toContainText(TEACHER.identifier);
      await shot(first, STAGE, 'isolation-first-account');

      // Clean up: A removes its favorite so a rerun starts from the same state.
      const remove = first.getByTestId('favorites-list').getByTestId('remove-math.functions');
      if ((await remove.count()) > 0) {
        await remove.click();
        await expect(first.getByTestId('favorites-empty')).toBeVisible();
      }
    } finally {
      await firstContext.close();
      await secondContext.close();
    }
  });
});
