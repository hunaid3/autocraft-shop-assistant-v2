/**
 * Help as a menu: a short welcome with a 📋 Menu button that opens the topics; each topic answers
 * with copy-ready examples (one in Hinglish), what it costs, and buttons to go on.
 * Staff see only what they can do. "help bill", "help stock"… jump straight to a topic.
 */
import type { Role } from './senders.js';
import type { Reply } from './router.js';

export type HelpTopic = 'bills' | 'purchases' | 'stockout' | 'questions' | 'shop' | 'staff' | 'credits' | 'support';

interface Topic { title: string; description: string; ownerOnly?: boolean; body: (owner: boolean) => string; buttons?: Array<[string, string]> }

const TOPICS: Record<HelpTopic, Topic> = {
  bills: {
    title: '🧾 Bills & quotes', description: 'GST bills, quotations, turning a quote into a bill',
    body: () => '🧾 *Bills & quotes*\n\n' +
      '*Bill:* bill Ravi Electronics 10 airdopes at 1250, 5 cables at 199\n' +
      '*With GSTIN:* bill Ravi gstin 36AABCU9603R1ZM 2 airdopes at 1250\n' +
      '*Hinglish:* Ravi ko 3 cable diye 200 ke\n' +
      '*Quote:* quote Ravi 10 airdopes at 1200 (or *estimate …*, add *valid 30 days*)\n' +
      '*Change a quote:* revise quote 1 10 airdopes at 1150\n' +
      '*Quote → bill:* convert quote 1\n\n' +
      'You see a summary first; tap ✅ Confirm to save. The PDF follows on WhatsApp.\n' +
      '💳 Bill 3 credits · quote 1 credit'
  },
  purchases: {
    title: '📥 Purchases & stock in', description: 'Supplier bills, bill photos, adding stock',
    body: () => '📥 *Purchases & adding stock*\n\n' +
      '*Purchase:* bought 50 airdopes @ 850 from Sharma Traders bill 4471\n' +
      '*Add stock:* add 50 cables @ 100 to stock, selling price 150 with 18% gst\n' +
      '*Hinglish:* Sharma se 20 charger liye 300 ke\n' +
      '*Bill photo:* just send a photo or PDF of the supplier bill; it comes back as a card to confirm\n' +
      '*Whole item list:* send an Excel or CSV file (owner; *template* for a ready sheet)\n\n' +
      'New items are created on Confirm; a selling price you give is saved on the item.\n' +
      '💳 Typed 1 credit · bill photo/PDF 3 credits · item list 10 (up to 10 items) or 25 (more than 10)'
  },
  stockout: {
    title: '📤 Stock out & returns', description: 'Samples, approval, damage, cash sale without bill',
    body: () => '📤 *Stock out without a bill*\n\n' +
      '*Sample:* gave 2 airdopes sample to Ravi\n' +
      '*On approval:* sent 5 airdopes on approval to Ravi\n' +
      '*Damaged / lost:* 3 cables damaged\n' +
      '*Shop use:* took 1 cable for shop use\n' +
      '*Cash sale:* sold 1 cable without bill\n' +
      '*Came back:* returned 2 airdopes from Ravi\n' +
      '*See what is out:* unbilled\n\n' +
      '💳 1 credit · returns free'
  },
  questions: {
    title: '📦 Stock & sales', description: 'Stock of an item, low stock, sales, open quotes',
    body: (owner) => '📦 *Ask anything*\n\n' +
      '• stock of airdopes\n• stock (all items)\n• low stock\n• quotes (open quotations)\n• unbilled (goods out without a bill)\n' +
      (owner ? '• sales today / this week / this month / last month\n• credits\n' : '') +
      '\nQuestions are free.'
  },
  shop: {
    title: '🏪 Shop details', description: 'GSTIN, address, UPI, logo, phone', ownerOnly: true,
    body: () => '🏪 *Shop details*\n\n' +
      '*See them:* profile\n' +
      '*GSTIN:* set once at sign-up; to change it, send *support*\n' +
      '*Address:* update address 12-3, Abids Road, Hyderabad 500001\n' +
      '*UPI:* update upi myshop@okhdfcbank (adds a pay QR on bills)\n' +
      '*Phone / email / name:* update phone 9876543210 · update email … · update shop name …\n' +
      '*Logo:* send a photo with the caption *logo*\n' +
      '*Dashboard:* send *dashboard* for sales, stock, bills, exports and shop settings (invoice prefix, bank details, logo) on the web\n' +
      '*Another shop:* *add shop* opens one more shop on this number (it needs its own GSTIN); *switch shop* moves between them\n\n' +
      'Changes show a card first. Free.'
  },
  staff: {
    title: '👥 Staff', description: 'Let others bill from their phones', ownerOnly: true,
    body: () => '👥 *Staff*\n\n' +
      '*Add:* add staff 9876543210 Ravi\nThen Ravi sends *Hi* to this number and taps *Accept*.\n' +
      '*See everyone:* staff\n*Remove:* remove staff Ravi\n\n' +
      'Staff can bill, quote, enter purchases and check stock. Sales, credits, expenses and shop settings stay with you.\n' +
      '💳 25 credits per staff (refunded if they decline or you cancel before they accept) · up to 5 staff'
  },
  credits: {
    title: '💳 Credits & prices', description: 'What each action costs, your balance', ownerOnly: true,
    body: () => '💳 *Credits* (1 credit = ₹1)\n\n' +
      '• Bill with PDF: 3\n• Bill read from a photo/PDF: 3\n• Quote: 1\n• Typed purchase / expense / stock entry: 1\n' +
      '• Stock out without a bill: 1 (returns free)\n• Staff: 25 each\n• Item list upload: 10 (up to 10 items) or 25 (more than 10)\n' +
      '• Questions, reports, help, shop details: free\n\n' +
      'Credits last 24 months; older credits are used first. Type *credits* for your balance, *recharge* to buy more.',
    buttons: [['RECHARGE', '💳 Recharge']]
  },
  support: {
    title: '💬 Talk to AutoCraft', description: 'Report a problem or ask us anything',
    body: () => '💬 *Talk to AutoCraft*\n\nSend *support* followed by your problem in one message, e.g.\n' +
      '*support the bill PDF did not come*\n\nYou can also tap the button below and then describe it. We reply on WhatsApp.',
    buttons: [['SUPPORT', '💬 Report a problem']]
  }
};

const ALIASES: Array<[RegExp, HelpTopic]> = [
  [/^(bills?|invoices?|quotes?|quotations?|estimates?|billing)$/, 'bills'],
  [/^(purchases?|bought|buy|stock ?in|bill photos?|photos?)$/, 'purchases'],
  [/^(stock ?out|samples?|returns?|damaged?|unbilled)$/, 'stockout'],
  [/^(stock|questions?|reports?|sales)$/, 'questions'],
  [/^(shop|profile|gst|gstin|address|upi|logo|settings?)$/, 'shop'],
  [/^(staff|team|employees?)$/, 'staff'],
  [/^(credits?|prices?|pricing|cost|charges?)$/, 'credits'],
  [/^(support|contact|complaint|problem)$/, 'support']
];

export function topicFromText(word: string): HelpTopic | null {
  const w = word.trim().toLowerCase();
  return ALIASES.find(([re]) => re.test(w))?.[1] ?? null;
}

export function helpMenu(name: string | null, role: Role, opening?: string): Reply[] {
  const owner = role === 'owner';
  const rows = (Object.entries(TOPICS) as Array<[HelpTopic, Topic]>)
    .filter(([, t]) => owner || !t.ownerOnly)
    .map(([id, t]) => ({ id: 'HELP:' + id, title: t.title, description: t.description }));
  return [{
    kind: 'list',
    text: opening ?? `👋 Hi${name ? ' ' + name : ''}! Type what you want to do, e.g. *bill Ravi 2 airdopes at 1250*, or tap *Menu* to see everything I can do.`,
    button: '📋 Menu', sectionTitle: 'What do you need?', rows
  }];
}

export function helpTopic(topic: HelpTopic, role: Role): Reply[] {
  const t = TOPICS[topic];
  if (t.ownerOnly && role !== 'owner') return [{ kind: 'text', text: 'That part is for the shop owner.' }];
  const buttons = [...(t.buttons ?? []), ['MENU', '📋 Back to menu']].map(([id, title]) => ({ id: id!, title: title! }));
  return [{ kind: 'buttons', text: t.body(role === 'owner').slice(0, 1024), buttons }];
}
