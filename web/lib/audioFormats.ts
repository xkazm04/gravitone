// The output formats the studio offers, and what each one means for a file the
// user keeps.
//
// The service speaks a much larger `output_format` grammar (mp3/pcm/wav at six
// sample rates and five bitrates — service/app.py::_parse_format). The studio
// deliberately surfaces TWO of them, because the studio is a place where you
// decide what to keep, not an API console:
//
//   wav_24000      the native rate, the lossless master, byte-identical to what
//                  every call produced before this parameter existed.
//   mp3_24000_128  the same audio at roughly a tenth the size — the difference
//                  between mailing a 64-line performance and linking to it.
//
// Everything else (pcm for a pipeline, resampled wav for a game engine, other
// bitrates) is a producer's concern and stays where producers already are: the
// `output_format` query parameter, which the code export now teaches.

export type OutputFormat = "wav_24000" | "mp3_24000_128";

export type OutputFormatMeta = {
  id: OutputFormat;
  /** Button label and the file extension the download carries. */
  label: string;
  ext: string;
  /** What the proxy labels the response as (the service sends the same). */
  mime: string;
  hint: string;
};

export const OUTPUT_FORMATS: readonly OutputFormatMeta[] = [
  {
    id: "wav_24000", label: "wav", ext: "wav", mime: "audio/wav",
    hint: "24 kHz wav — lossless master, the biggest file",
  },
  {
    id: "mp3_24000_128", label: "mp3", ext: "mp3", mime: "audio/mpeg",
    hint: "24 kHz mp3 at 128 kbps — about a tenth the size, for sending and sharing",
  },
] as const;

/** wav stays the default so a call that names no format is unchanged. */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "wav_24000";

/** Metadata for a format id, falling back to wav for takes rendered before the
 *  choice existed (restored from IndexedDB with no `format` field). */
export function formatMeta(id: string | undefined | null): OutputFormatMeta {
  return OUTPUT_FORMATS.find((f) => f.id === id) ?? OUTPUT_FORMATS[0];
}
