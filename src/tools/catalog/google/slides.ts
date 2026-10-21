import { obj, s, str, type ToolDef } from "../../kit.ts";
import { SLIDES, g, guard, gtool } from "./shared.ts";

const defs: ToolDef[] = [
  {
    spec: {
      name: "get_slide_thumbnail",
      description: "A picture of one slide of a Google Slides deck.",
      input_schema: obj({ presentationId: str("Presentation id."), pageObjectId: str("Slide id; empty for the first slide.") }, ["presentationId"]),
    },
    family: "google",
    labels: { running: "Fetching a slide…", done: "Fetched a slide" },
    sideEffect: false,
    async run(input, ctx) {
      let page = s(input.pageObjectId);
      if (!page) {
        const deck = await g<{ slides?: { objectId: string }[] }>(ctx, {
          method: "GET",
          url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}`,
          query: { fields: "slides(objectId)" },
        });
        page = deck.slides?.[0]?.objectId ?? "";
      }
      const r = await g<{ contentUrl?: string }>(ctx, {
        method: "GET",
        url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}/pages/${encodeURIComponent(page)}/thumbnail`,
      });
      return { ok: true, content: { pageObjectId: page, imageUrl: r.contentUrl }, evidence: `google:slides:${page}` };
    },
  },
  {
    spec: {
      name: "append_slides",
      description: "Add slides (title and body text each) to the end of a Google Slides deck.",
      input_schema: obj(
        {
          presentationId: str("Presentation id."),
          slides: { type: "array", items: obj({ title: str("Slide title."), body: str("Body text.") }, ["title"]), description: "Slides to add." },
        },
        ["presentationId", "slides"],
      ),
    },
    family: "google",
    labels: { running: "Adding slides…", done: "Added slides" },
    sideEffect: false,
    async run(input, ctx) {
      const held = guard(ctx, "OK to add slides to your deck?", s(input.presentationId), ["append_slides", s(input.presentationId), input.slides]);
      if (held) return held;
      const slides = Array.isArray(input.slides) ? (input.slides as { title?: unknown; body?: unknown }[]) : [];
      const requests: unknown[] = [];
      const ids: string[] = [];
      slides.slice(0, 20).forEach((sl, i) => {
        const id = `s_${Date.now().toString(36)}_${i}`;
        ids.push(id);
        requests.push({
          createSlide: {
            objectId: id,
            slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
            placeholderIdMappings: [
              { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: `${id}_t` },
              { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: `${id}_b` },
            ],
          },
        });
        requests.push({ insertText: { objectId: `${id}_t`, text: s(sl.title) } });
        if (s(sl.body)) requests.push({ insertText: { objectId: `${id}_b`, text: s(sl.body) } });
      });
      await g(ctx, { method: "POST", url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}:batchUpdate`, body: { requests } });
      return { ok: true, content: { slideIds: ids }, evidence: `google:slides:added:${ids.length}` };
    },
  },
  {
    spec: {
      name: "replace_slide",
      description: "Replace one slide's content with a new title and body.",
      input_schema: obj({ presentationId: str("Presentation id."), pageObjectId: str("Slide id to replace."), title: str("New title."), body: str("New body.") }, [
        "presentationId",
        "pageObjectId",
        "title",
      ]),
    },
    family: "google",
    labels: { running: "Updating slide…", done: "Updated slide" },
    sideEffect: false,
    async run(input, ctx) {
      const held = guard(ctx, "OK to change a slide in your deck?", s(input.pageObjectId), ["replace_slide", s(input.presentationId), s(input.pageObjectId), s(input.title)]);
      if (held) return held;
      const id = `s_${Date.now().toString(36)}`;
      const deck = await g<{ slides?: { objectId: string }[] }>(ctx, {
        method: "GET",
        url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}`,
        query: { fields: "slides(objectId)" },
      });
      const index = Math.max(
        0,
        (deck.slides ?? []).findIndex((x) => x.objectId === s(input.pageObjectId)),
      );
      await g(ctx, {
        method: "POST",
        url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}:batchUpdate`,
        body: {
          requests: [
            {
              createSlide: {
                objectId: id,
                insertionIndex: index,
                slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
                placeholderIdMappings: [
                  { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: `${id}_t` },
                  { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: `${id}_b` },
                ],
              },
            },
            { insertText: { objectId: `${id}_t`, text: s(input.title) } },
            ...(s(input.body) ? [{ insertText: { objectId: `${id}_b`, text: s(input.body) } }] : []),
            { deleteObject: { objectId: s(input.pageObjectId) } },
          ],
        },
      });
      return { ok: true, content: { slideId: id }, evidence: `google:slides:replaced:${s(input.pageObjectId)}` };
    },
  },
  {
    spec: {
      name: "delete_slide",
      description: "Delete one slide from a deck.",
      input_schema: obj({ presentationId: str("Presentation id."), pageObjectId: str("Slide id.") }, ["presentationId", "pageObjectId"]),
    },
    family: "google",
    labels: { running: "Removing slide…", done: "Removed slide" },
    sideEffect: false,
    async run(input, ctx) {
      const held = guard(ctx, "OK to delete a slide from your deck?", s(input.pageObjectId), ["delete_slide", s(input.presentationId), s(input.pageObjectId)]);
      if (held) return held;
      await g(ctx, {
        method: "POST",
        url: `${SLIDES}/${encodeURIComponent(s(input.presentationId))}:batchUpdate`,
        body: { requests: [{ deleteObject: { objectId: s(input.pageObjectId) } }] },
      });
      return { ok: true, content: "Deleted.", evidence: `google:slides:deleted:${s(input.pageObjectId)}` };
    },
  },
];
export const GOOGLE_SLIDES_TOOLS = defs.map(gtool);
