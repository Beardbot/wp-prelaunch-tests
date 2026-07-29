const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectTemplates,
  buildJourneyOptions,
  inventoryPaths,
  inventoryFormAt,
  fieldsFromSchema
} = require('../src/journey-generator');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SITE_URL = 'https://test.beardbot.dev';

function domForm({ labels = [], inputs = [], submitButtons = [] } = {}) {
  return { labels, inputs, submitButtons };
}

const contactDomForm = domForm({
  labels: [
    { text: 'Your name', for: 'form-field-name' },
    { text: 'Your email', for: 'form-field-email' }
  ],
  inputs: [
    { type: 'text', name: 'form_fields[name]', id: 'form-field-name', dataWpt: null },
    { type: 'email', name: 'form_fields[email]', id: 'form-field-email', dataWpt: null }
  ],
  submitButtons: [{ text: 'Send', dataWpt: 'contact-form-submit' }]
});

const loginDomForm = domForm({
  inputs: [
    { type: 'text', name: 'username', id: 'username', dataWpt: null },
    { type: 'password', name: 'password', id: 'password', dataWpt: null }
  ],
  submitButtons: [{ text: 'Log in', dataWpt: null }]
});

const emptyPage = { forms: [], searchInputs: [], dataWptElements: [] };

const inventoryFixture = {
  forms: {
    plugins: { elementor_pro: { active: true, version: '3.20.0' } },
    instances: [
      {
        provider: 'elementor_pro',
        page_id: 12,
        page_path: '/get-in-touch/',
        form_name: 'Contact',
        fields: [
          { type: 'text', label: 'Full name', required: true, custom_id: 'name' },
          { type: 'email', label: 'Email address', required: true, custom_id: 'email' },
          { type: 'select', label: 'Topic', required: false, custom_id: 'topic' },
          { type: 'textarea', label: 'Message', required: false, custom_id: 'message' },
          { type: 'text', label: '', required: false, custom_id: 'unlabelled' }
        ],
        has_recaptcha: false,
        submit_text: 'Send'
      }
    ]
  },
  woocommerce: {
    active: true,
    paths: { shop: '/store/', cart: '/cart/', checkout: '/checkout/', myaccount: '/account/' }
  }
};

// ─── inventoryPaths / inventoryFormAt / fieldsFromSchema ─────────────────────

test('inventoryPaths returns form page paths plus WooCommerce paths', () => {
  assert.deepEqual(inventoryPaths(inventoryFixture), [
    '/get-in-touch/', '/store/', '/cart/', '/checkout/', '/account/'
  ]);
});

test('inventoryPaths tolerates null and instances without a page path', () => {
  assert.deepEqual(inventoryPaths(null), []);
  assert.deepEqual(inventoryPaths({
    forms: { instances: [{ provider: 'gravity_forms', page_path: null }] }
  }), []);
});

test('inventoryFormAt matches trailing-slash-insensitively', () => {
  assert.equal(inventoryFormAt(inventoryFixture, '/get-in-touch').form_name, 'Contact');
  assert.equal(inventoryFormAt(inventoryFixture, '/get-in-touch/').form_name, 'Contact');
  assert.equal(inventoryFormAt(inventoryFixture, '/elsewhere/'), null);
  assert.equal(inventoryFormAt(null, '/get-in-touch/'), null);
});

test('fieldsFromSchema keeps labelled fillable fields in schema order', () => {
  const instance = inventoryFixture.forms.instances[0];
  assert.deepEqual(fieldsFromSchema(instance), [
    { label: 'Full name', value: '' },
    { label: 'Email address', value: '' },
    { label: 'Message', value: '' }
  ]);
  assert.deepEqual(fieldsFromSchema(null), []);
});

// ─── detectTemplates without inventory (unchanged behaviour) ─────────────────

test('detectTemplates without inventory detects a contact form from the DOM', () => {
  const inspections = { [`${SITE_URL}/contact/`]: { ...emptyPage, forms: [contactDomForm] } };
  const detected = detectTemplates(inspections, {});

  assert.equal(detected['contact-form'].pathname, '/contact/');
  assert.equal(detected['contact-form'].inventoryForm, null);
});

test('detectTemplates without inventory only sees login at /my-account', () => {
  const inspections = { [`${SITE_URL}/account/`]: { ...emptyPage, forms: [loginDomForm] } };
  assert.equal(detectTemplates(inspections, {}).login, undefined);

  const atMyAccount = { [`${SITE_URL}/my-account/`]: { ...emptyPage, forms: [loginDomForm] } };
  assert.equal(detectTemplates(atMyAccount, {}).login.pathname, '/my-account/');
});

// ─── detectTemplates with inventory ──────────────────────────────────────────

test('inventory form pages win over earlier DOM-only form pages', () => {
  // A generic page with a qualifying form is listed BEFORE the page the
  // inventory says hosts the real contact form.
  const inspections = {
    [`${SITE_URL}/newsletter/`]: { ...emptyPage, forms: [contactDomForm] },
    [`${SITE_URL}/get-in-touch/`]: { ...emptyPage, forms: [contactDomForm] }
  };

  const withoutInventory = detectTemplates(inspections, {});
  assert.equal(withoutInventory['contact-form'].pathname, '/newsletter/');

  const withInventory = detectTemplates(inspections, {}, inventoryFixture);
  assert.equal(withInventory['contact-form'].pathname, '/get-in-touch/');
  assert.equal(withInventory['contact-form'].inventoryForm.form_name, 'Contact');
});

test('login is detected at the real my-account path from the inventory', () => {
  const inspections = { [`${SITE_URL}/account/`]: { ...emptyPage, forms: [loginDomForm] } };
  const detected = detectTemplates(inspections, {}, inventoryFixture);

  assert.equal(detected.login.pathname, '/account/');
});

test('woocommerce detection carries the real shop path from the inventory', () => {
  const site = { journeys: ['woocommerce'] };
  const detected = detectTemplates({}, site, inventoryFixture);

  assert.deepEqual(detected.woocommerce, { existing: true, shopPath: '/store/' });
  // Without inventory: presence note only, as before.
  assert.deepEqual(detectTemplates({}, site).woocommerce, { existing: true });
});

// ─── buildJourneyOptions ─────────────────────────────────────────────────────

test('schema field labels are authoritative over DOM labels', () => {
  const detected = {
    'contact-form': {
      pageUrl: `${SITE_URL}/get-in-touch/`,
      pathname: '/get-in-touch/',
      form: contactDomForm,
      inventoryForm: inventoryFixture.forms.instances[0]
    }
  };
  const { journeyOptions } = buildJourneyOptions(detected, {}, {});

  assert.deepEqual(journeyOptions['templates/contact-form'].fields, [
    { label: 'Full name', value: '' },
    { label: 'Email address', value: '' },
    { label: 'Message', value: '' }
  ]);
  assert.equal(journeyOptions['templates/contact-form'].path, '/get-in-touch');
});

test('DOM labels remain the fallback when no schema matched', () => {
  const detected = {
    'contact-form': {
      pageUrl: `${SITE_URL}/contact/`,
      pathname: '/contact/',
      form: contactDomForm,
      inventoryForm: null
    }
  };
  const { journeyOptions } = buildJourneyOptions(detected, {}, {});

  assert.deepEqual(journeyOptions['templates/contact-form'].fields, [
    { label: 'Your name', value: '' },
    { label: 'Your email', value: '' }
  ]);
});

test('woocommerce shopPath is emitted only when it differs from the default', () => {
  const store = buildJourneyOptions({ woocommerce: { existing: true, shopPath: '/store/' } }, {}, {});
  assert.deepEqual(store.journeyOptions.woocommerce, { shopPath: '/store/' });

  const defaultShop = buildJourneyOptions({ woocommerce: { existing: true, shopPath: '/shop/' } }, {}, {});
  assert.equal(defaultShop.journeyOptions.woocommerce, undefined);

  const noPath = buildJourneyOptions({ woocommerce: { existing: true } }, {}, {});
  assert.equal(noPath.journeyOptions.woocommerce, undefined);
});
