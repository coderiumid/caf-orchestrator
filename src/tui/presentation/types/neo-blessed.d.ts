// neo-blessed is a maintained fork of blessed with the same API; reuse @types/blessed.
declare module 'neo-blessed' {
  import * as blessed from 'blessed';
  export = blessed;
}
