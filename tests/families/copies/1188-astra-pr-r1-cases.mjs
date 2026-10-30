// #1188's PR review r1 (Astra): its collision cases (`collision.py`), their second round (`cases/collision2.json`), its own
// cases (`cases/own.json`) and the blocker's reduction (`reduce.py`), as its case files hold them; each analysed by
// `probe/keptseq2.mjs` (R/astra-m4-i1188-pr-review-evidence/full-evidence.tar.gz).
export const cases = [
  [
    "apr-collision::collision/1/is/call",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[makeI(),peer]\nlet second=[makeS(),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/1/is/fallback",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[(hostValue otherwise {x:1}),peer]\nlet second=[(hostValue otherwise {x:"bad"}),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/1/is/object-call",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[{payload:makeI()},{payload:peer}]\nlet second=[{payload:makeS()},{payload:peer}]\nexit\n',
  ],
  [
    "apr-collision::collision/1/si/call",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[makeS(),peer]\nlet second=[makeI(),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/1/si/fallback",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[(hostValue otherwise {x:"bad"}),peer]\nlet second=[(hostValue otherwise {x:1}),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/1/si/object-call",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[{payload:makeS()},{payload:peer}]\nlet second=[{payload:makeI()},{payload:peer}]\nexit\n',
  ],
  [
    "apr-collision::collision/1/ii/call",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[makeI(),peer]\nlet second=[makeI(),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/1/ii/fallback",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[(hostValue otherwise {x:1}),peer]\nlet second=[(hostValue otherwise {x:1}),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/1/ii/object-call",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[{payload:makeI()},{payload:peer}]\nlet second=[{payload:makeI()},{payload:peer}]\nexit\n',
  ],
  [
    "apr-collision::collision/1/ss/call",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[makeS(),peer]\nlet second=[makeS(),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/1/ss/fallback",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[(hostValue otherwise {x:"bad"}),peer]\nlet second=[(hostValue otherwise {x:"bad"}),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/1/ss/object-call",
    'let t:integer=7\nlet peer={x:t}\nfunction makeI {return {x:1}}\nfunction makeS {return {x:"bad"}}\nlet first=[{payload:makeS()},{payload:peer}]\nlet second=[{payload:makeS()},{payload:peer}]\nexit\n',
  ],
  [
    "apr-collision::collision/2/is/call",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[makeI(),peer]\nlet second=[makeS(),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/2/is/fallback",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[(hostValue otherwise {x:{x:1}}),peer]\nlet second=[(hostValue otherwise {x:{x:"bad"}}),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/2/is/object-call",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[{payload:makeI()},{payload:peer}]\nlet second=[{payload:makeS()},{payload:peer}]\nexit\n',
  ],
  [
    "apr-collision::collision/2/si/call",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[makeS(),peer]\nlet second=[makeI(),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/2/si/fallback",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[(hostValue otherwise {x:{x:"bad"}}),peer]\nlet second=[(hostValue otherwise {x:{x:1}}),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/2/si/object-call",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[{payload:makeS()},{payload:peer}]\nlet second=[{payload:makeI()},{payload:peer}]\nexit\n',
  ],
  [
    "apr-collision::collision/2/ii/call",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[makeI(),peer]\nlet second=[makeI(),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/2/ii/fallback",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[(hostValue otherwise {x:{x:1}}),peer]\nlet second=[(hostValue otherwise {x:{x:1}}),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/2/ii/object-call",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[{payload:makeI()},{payload:peer}]\nlet second=[{payload:makeI()},{payload:peer}]\nexit\n',
  ],
  [
    "apr-collision::collision/2/ss/call",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[makeS(),peer]\nlet second=[makeS(),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/2/ss/fallback",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[(hostValue otherwise {x:{x:"bad"}}),peer]\nlet second=[(hostValue otherwise {x:{x:"bad"}}),peer]\nexit\n',
  ],
  [
    "apr-collision::collision/2/ss/object-call",
    'let t:integer=7\nlet peer={x:{x:t}}\nfunction makeI {return {x:{x:1}}}\nfunction makeS {return {x:{x:"bad"}}}\nlet first=[{payload:makeS()},{payload:peer}]\nlet second=[{payload:makeS()},{payload:peer}]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/is/fallback-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise good,peer]\nlet second=[hostValue otherwise bad,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/is/fallback-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise good]\nlet second=[peer,hostValue otherwise bad]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/is/fallback-alias/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise goodAlias,peer]\nlet second=[hostValue otherwise badAlias,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/is/fallback-alias/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise goodAlias]\nlet second=[peer,hostValue otherwise badAlias]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/is/load-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[load("key", default:good),peer]\nlet second=[load("key", default:bad),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/is/load-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,load("key", default:good)]\nlet second=[peer,load("key", default:bad)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/is/fromJson-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[fromJson(hostValue, default:good, files:false),peer]\nlet second=[fromJson(hostValue, default:bad, files:false),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/is/fromJson-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,fromJson(hostValue, default:good, files:false)]\nlet second=[peer,fromJson(hostValue, default:bad, files:false)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/si/fallback-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise bad,peer]\nlet second=[hostValue otherwise good,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/si/fallback-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise bad]\nlet second=[peer,hostValue otherwise good]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/si/fallback-alias/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise badAlias,peer]\nlet second=[hostValue otherwise goodAlias,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/si/fallback-alias/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise badAlias]\nlet second=[peer,hostValue otherwise goodAlias]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/si/load-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[load("key", default:bad),peer]\nlet second=[load("key", default:good),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/si/load-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,load("key", default:bad)]\nlet second=[peer,load("key", default:good)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/si/fromJson-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[fromJson(hostValue, default:bad, files:false),peer]\nlet second=[fromJson(hostValue, default:good, files:false),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/si/fromJson-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,fromJson(hostValue, default:bad, files:false)]\nlet second=[peer,fromJson(hostValue, default:good, files:false)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ii/fallback-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise good,peer]\nlet second=[hostValue otherwise good,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ii/fallback-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise good]\nlet second=[peer,hostValue otherwise good]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ii/fallback-alias/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise goodAlias,peer]\nlet second=[hostValue otherwise goodAlias,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ii/fallback-alias/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise goodAlias]\nlet second=[peer,hostValue otherwise goodAlias]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ii/load-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[load("key", default:good),peer]\nlet second=[load("key", default:good),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ii/load-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,load("key", default:good)]\nlet second=[peer,load("key", default:good)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ii/fromJson-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[fromJson(hostValue, default:good, files:false),peer]\nlet second=[fromJson(hostValue, default:good, files:false),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ii/fromJson-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,fromJson(hostValue, default:good, files:false)]\nlet second=[peer,fromJson(hostValue, default:good, files:false)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ss/fallback-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise bad,peer]\nlet second=[hostValue otherwise bad,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ss/fallback-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise bad]\nlet second=[peer,hostValue otherwise bad]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ss/fallback-alias/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise badAlias,peer]\nlet second=[hostValue otherwise badAlias,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ss/fallback-alias/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise badAlias]\nlet second=[peer,hostValue otherwise badAlias]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ss/load-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[load("key", default:bad),peer]\nlet second=[load("key", default:bad),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ss/load-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,load("key", default:bad)]\nlet second=[peer,load("key", default:bad)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ss/fromJson-named/0",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[fromJson(hostValue, default:bad, files:false),peer]\nlet second=[fromJson(hostValue, default:bad, files:false),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/1/ss/fromJson-named/1",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,fromJson(hostValue, default:bad, files:false)]\nlet second=[peer,fromJson(hostValue, default:bad, files:false)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/is/fallback-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise good,peer]\nlet second=[hostValue otherwise bad,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/is/fallback-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise good]\nlet second=[peer,hostValue otherwise bad]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/is/fallback-alias/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise goodAlias,peer]\nlet second=[hostValue otherwise badAlias,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/is/fallback-alias/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise goodAlias]\nlet second=[peer,hostValue otherwise badAlias]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/is/load-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[load("key", default:good),peer]\nlet second=[load("key", default:bad),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/is/load-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,load("key", default:good)]\nlet second=[peer,load("key", default:bad)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/is/fromJson-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[fromJson(hostValue, default:good, files:false),peer]\nlet second=[fromJson(hostValue, default:bad, files:false),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/is/fromJson-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,fromJson(hostValue, default:good, files:false)]\nlet second=[peer,fromJson(hostValue, default:bad, files:false)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/si/fallback-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise bad,peer]\nlet second=[hostValue otherwise good,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/si/fallback-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise bad]\nlet second=[peer,hostValue otherwise good]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/si/fallback-alias/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise badAlias,peer]\nlet second=[hostValue otherwise goodAlias,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/si/fallback-alias/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise badAlias]\nlet second=[peer,hostValue otherwise goodAlias]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/si/load-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[load("key", default:bad),peer]\nlet second=[load("key", default:good),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/si/load-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,load("key", default:bad)]\nlet second=[peer,load("key", default:good)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/si/fromJson-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[fromJson(hostValue, default:bad, files:false),peer]\nlet second=[fromJson(hostValue, default:good, files:false),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/si/fromJson-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,fromJson(hostValue, default:bad, files:false)]\nlet second=[peer,fromJson(hostValue, default:good, files:false)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ii/fallback-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise good,peer]\nlet second=[hostValue otherwise good,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ii/fallback-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise good]\nlet second=[peer,hostValue otherwise good]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ii/fallback-alias/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise goodAlias,peer]\nlet second=[hostValue otherwise goodAlias,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ii/fallback-alias/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise goodAlias]\nlet second=[peer,hostValue otherwise goodAlias]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ii/load-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[load("key", default:good),peer]\nlet second=[load("key", default:good),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ii/load-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,load("key", default:good)]\nlet second=[peer,load("key", default:good)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ii/fromJson-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[fromJson(hostValue, default:good, files:false),peer]\nlet second=[fromJson(hostValue, default:good, files:false),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ii/fromJson-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,fromJson(hostValue, default:good, files:false)]\nlet second=[peer,fromJson(hostValue, default:good, files:false)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ss/fallback-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise bad,peer]\nlet second=[hostValue otherwise bad,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ss/fallback-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise bad]\nlet second=[peer,hostValue otherwise bad]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ss/fallback-alias/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[hostValue otherwise badAlias,peer]\nlet second=[hostValue otherwise badAlias,peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ss/fallback-alias/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,hostValue otherwise badAlias]\nlet second=[peer,hostValue otherwise badAlias]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ss/load-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[load("key", default:bad),peer]\nlet second=[load("key", default:bad),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ss/load-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,load("key", default:bad)]\nlet second=[peer,load("key", default:bad)]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ss/fromJson-named/0",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[fromJson(hostValue, default:bad, files:false),peer]\nlet second=[fromJson(hostValue, default:bad, files:false),peer]\nexit\n',
  ],
  [
    "apr-collision2::collision2/2/ss/fromJson-named/1",
    'let t:integer=7\nlet peer={x:{x:t}}\nlet good={x:{x:1}}\nlet bad={x:{x:"bad"}}\nlet goodAlias=good\nlet badAlias=bad\nlet first=[peer,fromJson(hostValue, default:bad, files:false)]\nlet second=[peer,fromJson(hostValue, default:bad, files:false)]\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/0/variable",
    'let seed:integer=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/0/nested",
    'let seed:integer=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/0/copy",
    'let seed:integer=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/1/variable",
    'let seed:integer=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/1/nested",
    'let seed:integer=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/1/copy",
    'let seed:integer=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/3/variable",
    'let seed:integer=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/3/nested",
    'let seed:integer=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer/3/copy",
    'let seed:integer=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/0/variable",
    'let seed:integer | boolean=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/0/nested",
    'let seed:integer | boolean=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/0/copy",
    'let seed:integer | boolean=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/1/variable",
    'let seed:integer | boolean=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/1/nested",
    'let seed:integer | boolean=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/1/copy",
    'let seed:integer | boolean=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/3/variable",
    'let seed:integer | boolean=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/3/nested",
    'let seed:integer | boolean=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer | boolean/3/copy",
    'let seed:integer | boolean=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/0/variable",
    'let seed:integer?=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/0/nested",
    'let seed:integer?=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/0/copy",
    'let seed:integer?=43\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/1/variable",
    'let seed:integer?=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/1/nested",
    'let seed:integer?=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/1/copy",
    'let seed:integer?=43\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/3/variable",
    'let seed:integer?=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/3/nested",
    'let seed:integer?=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/integer?/3/copy",
    'let seed:integer?=43\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/0/variable",
    'let seed:number=2.5\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/0/nested",
    'let seed:number=2.5\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/0/copy",
    'let seed:number=2.5\nlet original={v:seed}\nlet rejected=[{v:"no"},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/1/variable",
    'let seed:number=2.5\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/1/nested",
    'let seed:number=2.5\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/1/copy",
    'let seed:number=2.5\nlet original={p:{v:seed}}\nlet rejected=[{p:{v:"no"}},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/3/variable",
    'let seed:number=2.5\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet target=original\ntarget=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/3/nested",
    'let seed:number=2.5\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet target={slot:original}\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/f1/number/3/copy",
    'let seed:number=2.5\nlet original={p:{p:{p:{v:seed}}}}\nlet rejected=[{p:{p:{p:{v:"no"}}}},original]\nlet source={slot:original}\nlet target=source\ntarget.slot=rejected.first\nexit\n',
  ],
  [
    "apr-own::own/two-scc/1/False/False",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{v:n}}\nlet b={p:{v:s}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet result=[aa,bb]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/1/False/True",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{v:n}}\nlet b={p:{v:s}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet uncertain=hostValue\nlet result=[aa,bb,uncertain]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/1/True/False",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{v:n}}\nlet b={p:{v:s}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet result=[bb,aa]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/1/True/True",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{v:n}}\nlet b={p:{v:s}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet uncertain=hostValue\nlet result=[bb,aa,uncertain]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/2/False/False",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{p:{v:n}}}\nlet b={p:{p:{v:s}}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet result=[aa,bb]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/2/False/True",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{p:{v:n}}}\nlet b={p:{p:{v:s}}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet uncertain=hostValue\nlet result=[aa,bb,uncertain]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/2/True/False",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{p:{v:n}}}\nlet b={p:{p:{v:s}}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet result=[bb,aa]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/2/True/True",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{p:{v:n}}}\nlet b={p:{p:{v:s}}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet uncertain=hostValue\nlet result=[bb,aa,uncertain]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/3/False/False",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{p:{p:{v:n}}}}\nlet b={p:{p:{p:{v:s}}}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet result=[aa,bb]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/3/False/True",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{p:{p:{v:n}}}}\nlet b={p:{p:{p:{v:s}}}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet uncertain=hostValue\nlet result=[aa,bb,uncertain]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/3/True/False",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{p:{p:{v:n}}}}\nlet b={p:{p:{p:{v:s}}}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet result=[bb,aa]\nexit\n',
  ],
  [
    "apr-own::own/two-scc/3/True/True",
    'let n:integer=53\nlet s:string="blue"\nlet a={p:{p:{p:{v:n}}}}\nlet b={p:{p:{p:{v:s}}}}\nlet aa=a\nlet bb=b\na=aa\naa=a\nb=bb\nbb=b\na=b\nb=a\nlet uncertain=hostValue\nlet result=[bb,aa,uncertain]\nexit\n',
  ],
  [
    "apr-own::own/forms/integer/first/False",
    "let unit:integer=43\nlet base={v:unit}\nlet other={v:unit}\nlet inner=[{v:false},base]\nlet outer=[inner.first,other]\nexit\n",
  ],
  [
    "apr-own::own/forms/integer/first/True",
    "let unit:integer=43\nlet base={v:unit}\nlet other={v:unit}\nlet inner=[{v:false},base]\nlet outer=[other,inner.first]\nexit\n",
  ],
  [
    "apr-own::own/forms/integer/last/False",
    "let unit:integer=43\nlet base={v:unit}\nlet other={v:unit}\nlet inner=[{v:false},base]\nlet outer=[inner.last,other]\nexit\n",
  ],
  [
    "apr-own::own/forms/integer/last/True",
    "let unit:integer=43\nlet base={v:unit}\nlet other={v:unit}\nlet inner=[{v:false},base]\nlet outer=[other,inner.last]\nexit\n",
  ],
  [
    "apr-own::own/forms/integer | string/first/False",
    "let unit:integer | string=43\nlet base={v:unit}\nlet other={v:unit}\nlet inner=[{v:false},base]\nlet outer=[inner.first,other]\nexit\n",
  ],
  [
    "apr-own::own/forms/integer | string/first/True",
    "let unit:integer | string=43\nlet base={v:unit}\nlet other={v:unit}\nlet inner=[{v:false},base]\nlet outer=[other,inner.first]\nexit\n",
  ],
  [
    "apr-own::own/forms/integer | string/last/False",
    "let unit:integer | string=43\nlet base={v:unit}\nlet other={v:unit}\nlet inner=[{v:false},base]\nlet outer=[inner.last,other]\nexit\n",
  ],
  [
    "apr-own::own/forms/integer | string/last/True",
    "let unit:integer | string=43\nlet base={v:unit}\nlet other={v:unit}\nlet inner=[{v:false},base]\nlet outer=[other,inner.last]\nexit\n",
  ],
  [
    "apr-own::own/control/numeric",
    "let seed:integer=43\nlet original={meta:{v:seed}}\nlet incoming={meta:{v:2.25}}\nlet target=original\ntarget=incoming\nexit\n",
  ],
  [
    "apr-own::own/control/union",
    'let seed:integer | string=43\nlet original={meta:{v:seed}}\nlet incoming={meta:{v:"ok"}}\nlet target=original\ntarget=incoming\nexit\n',
  ],
  [
    "apr-own::own/control/nullable",
    "let seed:integer?=43\nlet original={meta:{v:seed}}\nlet incoming={meta:{v:null}}\nlet target=original\ntarget=incoming\nexit\n",
  ],
  [
    "apr-own::own/control/plain",
    "let seed:integer=43\nlet original={meta:{v:seed}}\nlet incoming={meta:{v:43}}\nlet target=original\ntarget=incoming\nexit\n",
  ],
  [
    "apr-own::own/live-union/False/False",
    "let n:integer | string=3\nlet item={score:n}\nlet inner=[{rows:[{score:false}]},{rows:[item]}]\nlet result=[inner.first.rows.first,{score:n}]\nexit\n",
  ],
  [
    "apr-own::own/live-union/False/True",
    "let n:integer | string=3\nlet item={score:n}\nlet inner=[{rows:[{score:false}]},{rows:[item]}]\nlet result=[{score:n},inner.first.rows.first]\nexit\n",
  ],
  [
    "apr-own::own/live-union/True/False",
    "let n:integer | string=3\nlet item={score:n}\nlet inner=[{rows:[{score:false}]},{rows:[item]}]\nlet result=[inner.first.rows.first,item]\nexit\n",
  ],
  [
    "apr-own::own/live-union/True/True",
    "let n:integer | string=3\nlet item={score:n}\nlet inner=[{rows:[{score:false}]},{rows:[item]}]\nlet result=[item,inner.first.rows.first]\nexit\n",
  ],
  [
    "apr-reduced::reduced/load/list/False/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=[load("one", default:good),peer]\nlet second=[load("two", default:bad),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/list/False/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=[load("two", default:bad),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/list/False/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=[load("one", default:good),peer]\nlet second=[load("two", default:good),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/list/False/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=[load("two", default:bad),peer]\nlet first=[load("one", default:good),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/list/True/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=[peer,load("one", default:good)]\nlet second=[peer,load("two", default:bad)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/list/True/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=[peer,load("two", default:bad)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/list/True/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=[peer,load("one", default:good)]\nlet second=[peer,load("two", default:good)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/list/True/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=[peer,load("two", default:bad)]\nlet first=[peer,load("one", default:good)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/set/False/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=set[load("one", default:good),peer]\nlet second=set[load("two", default:bad),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/set/False/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=set[load("two", default:bad),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/set/False/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=set[load("one", default:good),peer]\nlet second=set[load("two", default:good),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/set/False/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=set[load("two", default:bad),peer]\nlet first=set[load("one", default:good),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/set/True/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=set[peer,load("one", default:good)]\nlet second=set[peer,load("two", default:bad)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/set/True/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=set[peer,load("two", default:bad)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/set/True/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=set[peer,load("one", default:good)]\nlet second=set[peer,load("two", default:good)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/set/True/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=set[peer,load("two", default:bad)]\nlet first=set[peer,load("one", default:good)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/dict/False/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=dict{a:load("one", default:good),b:peer}\nlet second=dict{a:load("two", default:bad),b:peer}\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/dict/False/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=dict{a:load("two", default:bad),b:peer}\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/dict/False/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=dict{a:load("one", default:good),b:peer}\nlet second=dict{a:load("two", default:good),b:peer}\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/dict/False/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=dict{a:load("two", default:bad),b:peer}\nlet first=dict{a:load("one", default:good),b:peer}\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/dict/True/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=dict{a:peer,b:load("one", default:good)}\nlet second=dict{a:peer,b:load("two", default:bad)}\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/dict/True/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=dict{a:peer,b:load("two", default:bad)}\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/dict/True/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=dict{a:peer,b:load("one", default:good)}\nlet second=dict{a:peer,b:load("two", default:good)}\nexit\n',
  ],
  [
    "apr-reduced::reduced/load/dict/True/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=dict{a:peer,b:load("two", default:bad)}\nlet first=dict{a:peer,b:load("one", default:good)}\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/list/False/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=[fromJson(hostValue, default:good, files:false),peer]\nlet second=[fromJson(hostValue, default:bad, files:false),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/list/False/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=[fromJson(hostValue, default:bad, files:false),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/list/False/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=[fromJson(hostValue, default:good, files:false),peer]\nlet second=[fromJson(hostValue, default:good, files:false),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/list/False/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=[fromJson(hostValue, default:bad, files:false),peer]\nlet first=[fromJson(hostValue, default:good, files:false),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/list/True/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=[peer,fromJson(hostValue, default:good, files:false)]\nlet second=[peer,fromJson(hostValue, default:bad, files:false)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/list/True/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=[peer,fromJson(hostValue, default:bad, files:false)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/list/True/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=[peer,fromJson(hostValue, default:good, files:false)]\nlet second=[peer,fromJson(hostValue, default:good, files:false)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/list/True/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=[peer,fromJson(hostValue, default:bad, files:false)]\nlet first=[peer,fromJson(hostValue, default:good, files:false)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/set/False/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=set[fromJson(hostValue, default:good, files:false),peer]\nlet second=set[fromJson(hostValue, default:bad, files:false),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/set/False/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=set[fromJson(hostValue, default:bad, files:false),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/set/False/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=set[fromJson(hostValue, default:good, files:false),peer]\nlet second=set[fromJson(hostValue, default:good, files:false),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/set/False/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=set[fromJson(hostValue, default:bad, files:false),peer]\nlet first=set[fromJson(hostValue, default:good, files:false),peer]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/set/True/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=set[peer,fromJson(hostValue, default:good, files:false)]\nlet second=set[peer,fromJson(hostValue, default:bad, files:false)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/set/True/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=set[peer,fromJson(hostValue, default:bad, files:false)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/set/True/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=set[peer,fromJson(hostValue, default:good, files:false)]\nlet second=set[peer,fromJson(hostValue, default:good, files:false)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/set/True/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=set[peer,fromJson(hostValue, default:bad, files:false)]\nlet first=set[peer,fromJson(hostValue, default:good, files:false)]\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/dict/False/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=dict{a:fromJson(hostValue, default:good, files:false),b:peer}\nlet second=dict{a:fromJson(hostValue, default:bad, files:false),b:peer}\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/dict/False/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=dict{a:fromJson(hostValue, default:bad, files:false),b:peer}\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/dict/False/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=dict{a:fromJson(hostValue, default:good, files:false),b:peer}\nlet second=dict{a:fromJson(hostValue, default:good, files:false),b:peer}\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/dict/False/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=dict{a:fromJson(hostValue, default:bad, files:false),b:peer}\nlet first=dict{a:fromJson(hostValue, default:good, files:false),b:peer}\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/dict/True/both",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=dict{a:peer,b:fromJson(hostValue, default:good, files:false)}\nlet second=dict{a:peer,b:fromJson(hostValue, default:bad, files:false)}\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/dict/True/only-bad",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=dict{a:peer,b:fromJson(hostValue, default:bad, files:false)}\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/dict/True/both-fit",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet first=dict{a:peer,b:fromJson(hostValue, default:good, files:false)}\nlet second=dict{a:peer,b:fromJson(hostValue, default:good, files:false)}\nexit\n',
  ],
  [
    "apr-reduced::reduced/fromJson/dict/True/swapped",
    'let t:integer=7\nlet peer={x:t}\nlet good={x:1}\nlet bad={x:"bad"}\nlet second=dict{a:peer,b:fromJson(hostValue, default:bad, files:false)}\nlet first=dict{a:peer,b:fromJson(hostValue, default:good, files:false)}\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "env REVIEW_MODES=<mode> TOUCH_ORACLE=<0|1> node probe/keptseq2.mjs <tree> cases/<phase>.json out/<label>.jsonl (phase collision, collision2, own, reduced)",
      "R/astra-m4-i1188-pr-review-evidence/full-evidence.tar.gz!queue.py:14",
    ],
  ],
  sources: 200,
  sha256: "db198b06dc0383ec48efe35dbc07946cb16ba3e2cfaa594265361ad40820052e",
};
