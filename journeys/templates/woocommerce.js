const { createStepRunner } = require('../../src/step');

async function run(site, context) {
  const opts = (site.journeyOptions && site.journeyOptions['templates/woocommerce']) ||
               (site.journeyOptions && site.journeyOptions['woocommerce']) || {};
  const shopPath = opts.shopPath || '/shop';
  const cartPath = opts.cartPath || '/cart';
  const checkoutPath = opts.checkoutPath || '/checkout';
  const productOffset = opts.productOffset || 0;

  const page = await context.newPage();
  const { step, getResult } = createStepRunner(page, site.key);

  try {
    await step('Shop page loads', async () => {
      const response = await page.goto(site.url + shopPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || response.status() >= 400) throw new Error(`Shop page returned status ${response?.status()}`);
      const products = await page.locator('.products .product, ul.products li.product').count();
      if (products === 0) throw new Error('No products found on shop page');
    });

    await step('Product page loads', async () => {
      await page.locator('.products .product, ul.products li.product').nth(productOffset).locator('a').first().click();
      await page.waitForLoadState('domcontentloaded');
      await page.locator('.single_add_to_cart_button').waitFor({ timeout: 10000 });
    });

    await step('Select variations (if any)', async () => {
      const variationForm = page.locator('.variations_form');
      if (await variationForm.count() === 0) return;
      const selects = variationForm.locator('table.variations select');
      const selectCount = await selects.count();
      for (let i = 0; i < selectCount; i++) {
        const values = await selects.nth(i).locator('option').evaluateAll(
          opts => opts.filter(o => o.value !== '').map(o => o.value)
        );
        if (values.length === 0) throw new Error('Variation select has no available options');
        await selects.nth(i).selectOption(values[0]);
      }
      await page.locator('.single_add_to_cart_button:not(.disabled)').waitFor({ timeout: 10000 });
    });

    await step('Select required product add-ons (if any)', async () => {
      const addons = page.locator('.wc-pao-addon-container');
      if (await addons.count() === 0) return;
      for (let i = 0; i < await addons.count(); i++) {
        const fieldset = addons.nth(i).locator('fieldset');
        if (await fieldset.count() === 0) continue;
        if (await fieldset.getAttribute('aria-required') !== 'true') continue;
        const swatchLinks = addons.nth(i).locator('a.wc-pao-addon-image-swatch');
        if (await swatchLinks.count() > 0) await swatchLinks.first().click();
      }
    });

    await step('Add to cart', async () => {
      await page.locator('.single_add_to_cart_button').click();
      await page.locator('.woocommerce-message, .added_to_cart').waitFor({ timeout: 10000 });
    });

    await step('Cart notification displayed', async () => {
      const text = await page.locator('.woocommerce-message, .added_to_cart').first().textContent();
      if (!text || text.trim().length === 0) throw new Error('Cart notification was empty');
    });

    await step('Cart page — product present', async () => {
      await page.goto(site.url + cartPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('.woocommerce-cart-form .cart tr.cart_item, .wc-block-cart-items__row')
        .first().waitFor({ timeout: 10000 });
    });

    await step('Checkout page loads', async () => {
      await page.goto(site.url + checkoutPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator('form.checkout, form[name="checkout"], .wp-block-woocommerce-checkout')
        .first().waitFor({ timeout: 10000 });
    });

    await step('Payment options present', async () => {
      const classic = await page.locator('input[name="payment_method"]').count();
      const block = await page.locator('.wc-block-components-payment-method-label').count();
      if (classic === 0 && block === 0) throw new Error('No payment methods found on checkout page');
    });

  } finally {
    await page.close();
  }

  return getResult();
}

module.exports = { run };
