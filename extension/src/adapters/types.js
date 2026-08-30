// The shape every adapter returns. Deliberately small: only what the verdict
// engine needs, plus enough identity to cache a result per SKU later.
//
// Every field except `url` is optional, and the panel degrades rather than
// failing — a fabric with no weave still gets a colour verdict, and a page
// where only the image resolves is still worth something to the shopper.

/**
 * @typedef {Object} Product
 * @property {string}   url        canonical product URL
 * @property {string=}  sku        marketplace product id
 * @property {string=}  title
 * @property {string=}  price
 * @property {string=}  currency
 * @property {string[]} images     best-resolution image URLs, most useful first
 * @property {string=}  weave      lawn / cambric / chiffon / khaddar
 * @property {string=}  embellishment  printed / embroidered
 * @property {string=}  pieces     "3 Piece"
 * @property {string}   adapter    which adapter produced this
 * @property {string[]} warnings   what could not be read, for diagnostics
 */

export const EMPTY = {
  url: "",
  images: [],
  adapter: "none",
  warnings: [],
};
