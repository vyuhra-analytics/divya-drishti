// A crude-oil price-direction word list, written for the sentiment study (deviation D2 in research/sentiment/PREREGISTRATION.md) and FIXED before any
// result was seen: a change adds a trial to the counter. A general finance tone list scores "attack on oil tankers" as negative, but for the price it is
// bullish, so this list scores what a headline implies for the PRICE of crude: bullish (+) words and phrases against bearish (-) ones. Original work.
// tone = (bullish - bearish) / (bullish + bearish + 1), each pattern counted once per headline, in [-1, 1].

/** Inventory moves are read first and taken out of the text, so "inventories fell" is one bullish signal and not also a bearish "fell". */
const inventoryDraw: RegExp[] = [
  /\b(?:inventor(?:y|ies)|stocks?|stockpiles?|reserves?) (?:fall|falls|fell|drop|drops|dropped|decline|declines|declined|draw|draws|drew|shrink|shrinks|shrank|dwindle|dwindles)\b/i,
  /\b(?:draws?|drawdowns?) (?:in|of) (?:crude|oil|inventor\w+|stocks?|stockpiles?)\b/i,
];
const inventoryBuild: RegExp[] = [
  /\b(?:inventor(?:y|ies)|stocks?|stockpiles?|reserves?) (?:rise|rises|rose|build|builds|built|increase|increases|increased|climb|climbs|jump|jumps|swell|swells|balloon)\b/i,
  /\b(?:builds?) (?:in|of) (?:crude|oil|inventor\w+|stocks?|stockpiles?)\b/i,
];

const bullish: RegExp[] = [
  /\b(?:surg(?:e|es|ed|ing)|jump(?:s|ed|ing)?|rall(?:y|ies|ied|ying)|soar(?:s|ed|ing)?|spik(?:e|es|ed|ing)|climb(?:s|ed|ing)?|rebound(?:s|ed|ing)?|gain(?:s|ed|ing)?|rise|rises|rose|rising|higher|firm(?:s|ed|er)?|advance(?:s|d)?)\b/i,
  /\b(?:output|production|supply|supplies) cuts?\b/i,
  /\bcuts? (?:output|production|supply|exports)\b/i,
  /\b(?:supply|supplies) (?:disruption|disruptions|outage|outages|shortage|shortages|squeeze|tightness|concerns?|risk|risks|fears?)\b/i,
  /\b(?:tighter|tightening|tight) (?:supply|supplies|market)\b/i,
  /\b(?:outage|outages|shortage|shortages|blockade|embargo|sanctions?|disruptions?)\b/i,
  /\b(?:attack(?:s|ed)?|strikes?|drone|missile|explosion|fire) (?:on|at|hits?|hit|near)\b/i,
  /\b(?:attack(?:s|ed)?|struck|hit|hits|seiz(?:e|es|ed|ure)|closure|closes|closed|reopening delayed)\b.*\b(?:tankers?|refiner(?:y|ies)|pipeline|hormuz|oilfield|terminal)\b/i,
  /\b(?:tankers?|refiner(?:y|ies)|pipeline|hormuz|oilfield|terminal)\b.*\b(?:attack(?:s|ed)?|struck|hit|hits|seiz(?:e|es|ed|ure)|closure|closed|blocked)\b/i,
  /\b(?:tensions?|escalat(?:e|es|ed|ion|ing)|war|conflict|unrest|geopolitic\w*)\b/i,
  /\b(?:strong|stronger|robust|rising|rebounding|recovering|higher) demand\b/i,
  /\bdemand (?:rises|rose|growth|recovery|rebounds?|surges?|jumps?|picks up)\b/i,
  /\b(?:opec\+?|saudi\w*|russia\w*) (?:agree[sd]?|extend[sd]?|deepen[sd]?|signal[sd]?) (?:to )?(?:cut|cuts|curbs?|restraint)\b/i,
];

const bearish: RegExp[] = [
  /\b(?:fall|falls|fell|falling|drop|drops|dropped|dropping|slump(?:s|ed|ing)?|slid(?:e|es|ing)?|declin(?:e|es|ed|ing)|tumbl(?:e|es|ed|ing)|plung(?:e|es|ed|ing)|slip(?:s|ped|ping)?|sink(?:s|ing)?|sank|lower|weaker|retreat(?:s|ed|ing)?|ease[sd]?|easing|sell-?off|loses|lost|losses|pare[sd]?)\b/i,
  /\b(?:weak|weaker|weakening|soft|softer|sluggish|slowing|falling|lower|lacklustre|lackluster|poor) demand\b/i,
  /\bdemand (?:worries|concerns?|fears?|slump(?:s)?|slows?|weakens?|falls?|drops?|destruction)\b/i,
  /\b(?:glut|oversupply|over-supply|surplus|supply (?:surge|growth|increase|rises?)|excess supply|swelling supply)\b/i,
  /\b(?:raise[sd]?|boost(?:s|ed)?|increase[sd]?|ramp(?:s|ed)? up|lift(?:s|ed)?|hike[sd]?) (?:output|production|supply|exports|quotas?)\b/i,
  /\b(?:output|production|supply|exports) (?:rises?|rose|increases?|increased|boost|hike|jumps?|growth|expansion)\b/i,
  /\b(?:ceasefire|cease-fire|peace (?:deal|plan|talks?|agreement)|truce|de-?escalat\w*|eases? tensions?|easing tensions|talks (?:progress|resume)|deal reached|reopen(?:s|ed|ing)?|resum(?:e|es|ed|ing) (?:exports|shipments|flows|output|production))\b/i,
  /\b(?:recession|slowdown|downturn|economic (?:worries|concerns|fears|slump|weakness)|growth (?:worries|concerns|fears)|trade war|tariffs?)\b/i,
  /\b(?:strong(?:er)? dollar|dollar (?:strengthens|gains|rises|rallies))\b/i,
];

export interface ToneScore {
  bullish: number;
  bearish: number;
  /** (bullish - bearish) / (bullish + bearish + 1), in [-1, 1]; 0 for a headline with no word of either kind */
  tone: number;
}

/** The crude price-direction tone of a headline. */
export function crudeTone(title: string): ToneScore {
  let text = title;
  let up = 0;
  let down = 0;
  for (const re of inventoryDraw) {
    if (re.test(text)) {
      up++;
      text = text.replace(new RegExp(re.source, "gi"), " ");
    }
  }
  for (const re of inventoryBuild) {
    if (re.test(text)) {
      down++;
      text = text.replace(new RegExp(re.source, "gi"), " ");
    }
  }
  up += bullish.filter((re) => re.test(text)).length;
  down += bearish.filter((re) => re.test(text)).length;
  return { bullish: up, bearish: down, tone: (up - down) / (up + down + 1) };
}
