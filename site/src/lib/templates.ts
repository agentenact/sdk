/**
 * The panel's ready agents, as the site lists them. Ids and wording mirror agentenact-cloud's
 * apps/api/src/builder/templates.ts; each opens in the panel through `templateUrl`.
 */
/** A plan sentence: plain text, with `{ v }` marking a value the owner can change in the panel. */
export type PlanPart = string | { v: string };

/** `email` is an illustrative example of what each agent sends, shown labelled as an example; its numbers are made up. */
export const TEMPLATES = [
  {
    id: 'xlm-drop', group: 'Prices', title: 'XLM drop alert', summary: 'Emails you when XLM falls sharply in an hour.',
    plan: ['Every 5 minutes I look at XLM and email you if it falls ', { v: '5%' }, ' or more in an hour.'],
    checks: 'Every 5 min', reads: 'XLM price',
    email: { subject: 'XLM fell 6.2% in the last hour', body: 'XLM is at $0.312, down from $0.333 an hour ago.' },
  },
  {
    id: 'coin-crash', group: 'Prices', title: 'Crash alert', summary: 'Emails you when BTC, ETH, SOL or XLM falls hard in a day.',
    plan: ['Every 15 minutes I look at ', { v: 'BTC' }, ' and email you if it falls ', { v: '10%' }, ' or more in a day.'],
    checks: 'Every 15 min', reads: 'Coin price',
    email: { subject: 'BTC fell 11% today', body: 'BTC is at $88,400, down from $99,300 a day ago.' },
  },
  {
    id: 'coin-jump', group: 'Prices', title: 'Price jump alert', summary: 'Emails you when a coin rises sharply in an hour.',
    plan: ['Every 5 minutes I look at ', { v: 'ETH' }, ' and email you if it rises ', { v: '5%' }, ' or more in an hour.'],
    checks: 'Every 5 min', reads: 'Coin price',
    email: { subject: 'ETH rose 5.4% in the last hour', body: 'ETH is at $3,920, up from $3,719 an hour ago.' },
  },
  {
    id: 'price-target', group: 'Prices', title: 'XLM price target', summary: 'Emails you once XLM reaches the price you pick.',
    plan: ['Every 5 minutes I check the XLM price and email you once it reaches ', { v: '$1' }, '.'],
    checks: 'Every 5 min', reads: 'XLM price',
    email: { subject: 'XLM reached $1', body: 'XLM is trading at $1.004 right now.' },
  },
  {
    id: 'usdc-peg', group: 'Prices', title: 'USDC peg watch', summary: 'Emails you if USDC slips below a dollar.',
    plan: ['Every 5 minutes I check that USDC is worth a dollar and email you if it falls below ', { v: '$0.99' }, '.'],
    checks: 'Every 5 min', reads: 'USDC price',
    email: { subject: 'USDC is below a dollar', body: 'USDC is trading at $0.987. It was $0.999 an hour ago.' },
  },
  {
    id: 'btc-range', group: 'Prices', title: 'BTC range alert', summary: 'Emails you when BTC leaves the price range you set.',
    plan: ['Every 5 minutes I check the BTC price and email you if it goes below ', { v: '$75,000' }, ' or above ', { v: '$90,000' }, '.'],
    checks: 'Every 5 min', reads: 'BTC price',
    email: { subject: 'BTC broke above your range', body: 'BTC is at $90,640, above the $90,000 you set.' },
  },
  {
    id: 'big-move', group: 'Prices', title: 'Big move alert', summary: 'Emails you when a coin moves sharply in an hour, up or down.',
    plan: ['Every 5 minutes I look at ', { v: 'SOL' }, ' and email you if it moves ', { v: '4%' }, ' or more in an hour, up or down.'],
    checks: 'Every 5 min', reads: 'Hourly change',
    email: { subject: 'SOL moved 5.2% in an hour', body: 'SOL fell from $182.40 to $172.90 in the last hour.' },
  },
  {
    id: 'wallet-watch', group: 'Wallets', title: 'Wallet watcher', summary: 'Emails you when a wallet sends or receives money.',
    plan: ['Every 5 minutes I look at ', { v: 'your wallet' }, ' and email you if it receives or sends money.'],
    checks: 'Every 5 min', reads: 'Wallet payments',
    email: { subject: 'Your wallet moved money', body: 'GBX4…7QLM sent 250 XLM to GCA2…P3TE.' },
  },
  {
    id: 'payment-received', group: 'Wallets', title: 'Payment received', summary: 'Emails you when money arrives in a wallet.',
    plan: ['Every 5 minutes I look at ', { v: 'your wallet' }, ' and email you when money arrives.'],
    checks: 'Every 5 min', reads: 'Wallet payments',
    email: { subject: 'You received 40 USDC', body: 'GCA2…P3TE paid your wallet 40 USDC.' },
  },
  {
    id: 'big-usdc', group: 'Wallets', title: 'Big USDC moves', summary: 'Emails you when a wallet moves a large amount of USDC.',
    plan: ['Every 5 minutes I look at ', { v: 'your wallet' }, ' and email you if it moves ', { v: '10,000 USDC' }, ' or more.'],
    checks: 'Every 5 min', reads: 'Wallet payments',
    email: { subject: 'A big USDC move', body: 'Your wallet sent 25,000 USDC to GDQ5…M2RA.' },
  },
  {
    id: 'low-balance', group: 'Wallets', title: 'Low balance alert', summary: 'Emails you before a wallet runs low on XLM.',
    plan: ['Every hour I look at ', { v: 'your wallet' }, ' and email you if it holds less than ', { v: '100 XLM' }, '.'],
    checks: 'Every hour', reads: 'Wallet balance',
    email: { subject: 'Your wallet is low on XLM', body: 'It holds 62.4 XLM, below your 100 XLM line.' },
  },
  {
    id: 'daily-digest', group: 'Daily notes', title: 'Daily Stellar digest', summary: 'Writes a short Stellar DeFi digest every day.',
    plan: ['Every ', { v: 'morning' }, ' I write a short Stellar DeFi digest and email it to you.'],
    checks: 'Once a day', reads: 'News and prices',
    email: { subject: 'Stellar DeFi, this morning', body: 'Three things moved overnight: …' },
  },
  {
    id: 'morning-prices', group: 'Daily notes', title: 'Morning prices', summary: 'Emails you XLM, BTC and ETH prices every day.',
    plan: ['Every ', { v: 'morning' }, ' I email you the prices of XLM, BTC and ETH and how much each moved in the last day.'],
    checks: 'Once a day', reads: 'Prices',
    email: { subject: 'Prices this morning', body: 'XLM $0.31 (−1.2%) · BTC $97,800 (+0.8%) · ETH $3,840 (+2.1%)' },
  },
  {
    id: 'weekly-recap', group: 'Daily notes', title: 'Weekly crypto recap', summary: 'Writes a short recap of the crypto week.',
    plan: ['Every ', { v: 'Monday morning' }, ' I write a short recap of the crypto week and email it to you.'],
    checks: 'Once a week', reads: 'News and prices',
    email: { subject: 'Your crypto week', body: 'The biggest move this week was …' },
  },
  {
    id: 'market-morning', group: 'Daily notes', title: 'Market morning', summary: 'Emails you prices and the day’s top crypto headline.',
    plan: ['Every ', { v: 'morning' }, ' I email you the prices of BTC, ETH and XLM with the one crypto headline that matters most that day.'],
    checks: 'Once a day', reads: 'Prices and news',
    email: { subject: 'Your market morning', body: 'BTC $80,500 (+0.6%), ETH … Today’s headline: …' },
  },
  {
    id: 'agent-economy', group: 'Daily notes', title: 'Agent economy weekly', summary: 'Writes a weekly brief on AI agents that pay and get paid.',
    plan: ['Every ', { v: 'Monday morning' }, ' I read the week’s news on AI agents that pay and get paid, and email you a short brief.'],
    checks: 'Once a week', reads: 'News',
    email: { subject: 'The agent economy this week', body: 'Five things that happened, each with its source: …' },
  },
] as const satisfies readonly { id: string; group: string; title: string; summary: string; plan: readonly PlanPart[]; checks: string; reads: string; email: { subject: string; body: string } }[];

export type Template = (typeof TEMPLATES)[number];

/** The groups in their listed order, each with its templates. */
export const TEMPLATE_GROUPS = [...new Set(TEMPLATES.map((t) => t.group))].map((group) => ({ group, items: TEMPLATES.filter((t) => t.group === group) }));
