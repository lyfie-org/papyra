export const NOTE_THEMES = [
  { name: 'default',  label: 'Default'  },
  { name: 'mint',     label: 'Mint'     },
  { name: 'sand',     label: 'Sand'     },
  { name: 'rose',     label: 'Rose'     },
  { name: 'sky',      label: 'Sky'      },
  { name: 'lavender', label: 'Lavender' },
  { name: 'sage',     label: 'Sage'     },
  { name: 'fog',      label: 'Fog'      },
  { name: 'storm',    label: 'Storm'    },
  { name: 'dusk',     label: 'Dusk'     },
  { name: 'blossom',  label: 'Blossom'  },
  { name: 'clay',     label: 'Clay'     },
] as const;

export const NOTE_ART = [
  { name: 'none',        label: 'None' },
  { name: 'groceries',   label: 'Groceries' },
  { name: 'food',        label: 'Food' },
  { name: 'music',       label: 'Music' },
  { name: 'recipes',     label: 'Recipes' },
  { name: 'notes',       label: 'Notes' },
  { name: 'places',      label: 'Places' },
  { name: 'travel',      label: 'Travel' },
  { name: 'video',       label: 'Video' },
  { name: 'celebration', label: 'Celebration' },
] as const;

export type NoteTheme = typeof NOTE_THEMES[number]['name'];
export type NoteArt = typeof NOTE_ART[number]['name'];

const THEME_NAMES = new Set<string>(NOTE_THEMES.map(t => t.name));
const ART_NAMES = new Set<string>(NOTE_ART.map(a => a.name));

export interface ResolvedTheme {
  colorTheme: NoteTheme;
  artTheme: NoteArt;
}

/** Parses a composite theme string (e.g., 'mint:groceries') and returns color and art themes. */
export function resolveTheme(raw: string | undefined | null): ResolvedTheme {
  let colorTheme: NoteTheme = 'default';
  let artTheme: NoteArt = 'none';

  if (raw) {
    const parts = raw.split(':');
    const parsedColor = parts[0];
    const parsedArt = parts[1];

    if (parsedColor && THEME_NAMES.has(parsedColor)) {
      colorTheme = parsedColor as NoteTheme;
    }
    if (parsedArt && ART_NAMES.has(parsedArt)) {
      artTheme = parsedArt as NoteArt;
    }
  }

  return { colorTheme, artTheme };
}
