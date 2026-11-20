// The sample layer set: bob's role layers from the regression corpus, so the
// auto-rig can be tried without art of one's own. Globbed as URLs, so the
// PNGs ship as build assets and are fetched only when asked for.
const SAMPLE_URLS = import.meta.glob<string>(
  "../../../corpus/bob/layers/*.png",
  { query: "?url", import: "default", eager: true },
);

const fileName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** The sample's layer file names (`face.png`, `eye_L.png`, …). */
export const SAMPLE_LAYER_NAMES: readonly string[] =
  Object.keys(SAMPLE_URLS).map(fileName);

/** The sample layers as the `File`s a file picker would hand over. */
export async function fetchSampleLayers(): Promise<File[]> {
  return Promise.all(
    Object.entries(SAMPLE_URLS).map(async ([path, url]) => {
      const name = fileName(path);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`sample layers: ${name} answered ${response.status}`);
      }
      return new File([await response.blob()], name, { type: "image/png" });
    }),
  );
}

/** True when the page was opened as `?sample`, the link that shows the
 *  auto-rig at work: the sample is imported on load and idles. */
export function sampleRequested(): boolean {
  return new URLSearchParams(window.location.search).has("sample");
}
