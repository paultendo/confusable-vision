/**
 * macOS system faces that are not text faces: handwriting and calligraphy, engraved, small-capital or all-capital
 * display faces, decorative faces, and symbol fonts. A character pair that only looks alike in these (π and n in a
 * brush script, say) is not a lookalike in the interfaces, addresses and names where confusables matter, so
 * release 2 reports text-font counts separately. Comic Sans MS and Impact stay text faces: both appear in real
 * interfaces.
 */
export const DISPLAY_FONTS = new Set([
  "Academy Engraved LET", "Apple Chancery", "Apple Symbols", "Bodoni 72 Smallcaps", "Bradley Hand", "Brush Script MT",
  "Chalkboard", "Chalkboard SE", "Chalkduster", "Copperplate", "Herculanum", "Luminari", "Marker Felt", "Noteworthy",
  "Papyrus", "Party LET", "Phosphate", "Savoye LET", "SignPainter", "Snell Roundhand", "Trattatello", "Zapfino",
]);
