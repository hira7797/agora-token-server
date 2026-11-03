'use strict';

// Must stay identical to Android PremiumProductCatalog.kt and Play Console.
const SUBSCRIPTIONS = Object.freeze({
  shaadi360_gold_basic: { tier: 'basic' },
  shaadi360_gold_advanced: { tier: 'advanced' },
});

const CONSUMABLES = Object.freeze({
  shaadi360_message_requests_10: { messageRequestCredits: 10, boostCredits: 0 },
  shaadi360_message_requests_25: { messageRequestCredits: 25, boostCredits: 0 },
  shaadi360_message_requests_50: { messageRequestCredits: 50, boostCredits: 0 },
  shaadi360_boost_1: { messageRequestCredits: 0, boostCredits: 1 },
  shaadi360_boost_5: { messageRequestCredits: 0, boostCredits: 5 },
  shaadi360_boost_10: { messageRequestCredits: 0, boostCredits: 10 },
});

function classifyProduct(productId) {
  if (SUBSCRIPTIONS[productId]) return { type: 'subscription', ...SUBSCRIPTIONS[productId] };
  if (CONSUMABLES[productId]) return { type: 'consumable', ...CONSUMABLES[productId] };
  return null;
}

module.exports = { SUBSCRIPTIONS, CONSUMABLES, classifyProduct };
