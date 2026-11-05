// Arc Max's Tidy Downloads: a name from the file and the page, against the cases Arc showed off and the names a
// browser actually hands over. Nothing here renames a file; these are the words the offer is made from.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPageTitle, isUserNamedDownload, looksGenerated, modelTidyName, splitFilename, tidyDownloadName, tidyNameFor } from "./tidyDownloads.ts";

test("splitFilename keeps a whole archive extension", () => {
  assert.deepEqual(splitFilename("IMG_8812.JPG"), { stem: "IMG_8812", extension: "JPG" });
  assert.deepEqual(splitFilename("backup.tar.gz"), { stem: "backup", extension: "tar.gz" });
  assert.deepEqual(splitFilename("README"), { stem: "README", extension: "" });
  assert.deepEqual(splitFilename("/Users/owner/Downloads/Report.pdf"), { stem: "Report", extension: "pdf" });
});

test("looksGenerated knows a camera, a hash, a date and a save-panel name", () => {
  for (const name of [
    "IMG_20261024_8812",
    "DSC_0042",
    "Screenshot 2026-10-24 at 12.34.56",
    "original",
    "report_final_final_v2",
    "photo-2026-01-02-abc123def456",
    "gw_hura_s_02",
    "57557750-3c95-4ba0-957f-63e12bcba39e",
  ])
    assert.equal(looksGenerated(name), true, name);
  for (const name of ["Q4 2025 Roadmap", "How to feel less stressed", "NASA Artemis 2 launch", "My Report"]) assert.equal(looksGenerated(name), false, name);
});

test("looksGenerated does not remember the last name between downloads", () => {
  assert.equal(looksGenerated("IMG_1234"), true);
  assert.equal(looksGenerated("Q4 2025 Roadmap"), false);
  assert.equal(looksGenerated("IMG_1234"), true);
});

test("cleanPageTitle keeps the subject and drops the site's name and byline", () => {
  assert.equal(cleanPageTitle("How to feel less stressed | Psyche Guides"), "How to feel less stressed");
  assert.equal(cleanPageTitle("Q3 2026 Report — Acme"), "Q3 2026 Report");
  assert.equal(cleanPageTitle("Huracan S 02 by The Browser Company"), "Huracan S 02");
  assert.equal(cleanPageTitle("(3) Inbox — Mail"), "Inbox");
  assert.equal(cleanPageTitle("Download Q3 2026 Report | Acme"), "Q3 2026 Report");
});

test("the plan's camera name takes the page's name", () => {
  const tidy = tidyDownloadName({ filename: "IMG_20261024_8812.pdf", pageTitle: "Q3 2026 Report | Acme" });
  assert.equal(tidy?.filename, "Q3 2026 Report.pdf");
  assert.equal(tidy?.stem, "Q3 2026 Report");
  assert.equal(tidy?.basis, "page");
});

test("Arc's original.avif takes the page's title", () => {
  const tidy = tidyDownloadName({ filename: "original.avif", pageTitle: "How to feel less stressed" });
  assert.equal(tidy?.filename, "How to Feel Less Stressed.avif");
  assert.equal(tidy?.basis, "page");
});

test("Arc's Midjourney prompt drops its handle, hash and dangling words", () => {
  const tidy = tidyDownloadName({
    filename: "rahulchowdhury._close_up_portrait_of_an_astronaut_floating_in_s_57557750-3c95-4ba0-957f-63e12bcba39e.png",
    pageTitle: "Midjourney",
  });
  assert.equal(tidy?.filename, "Close Up Portrait of an Astronaut Floating.png");
  assert.equal(tidy?.basis, "file");
});

test("a clipped name is spelled out by the page", () => {
  const tidy = tidyDownloadName({ filename: "gw_hura_s_02.webp", pageTitle: "Huracan S 02 by Someone | Unsplash" });
  assert.equal(tidy?.filename, "Huracan S 02.webp");
  assert.equal(tidy?.basis, "page");
});

test("an underscored readable name is only spaced and title-cased", () => {
  assert.equal(tidyDownloadName({ filename: "how_to_feel_less_stressed.avif" })?.filename, "How to Feel Less Stressed.avif");
  assert.equal(tidyDownloadName({ filename: "my_notes.txt" })?.filename, "My Notes.txt");
  assert.equal(tidyDownloadName({ filename: "Project_Plan_v3.docx", pageTitle: "Launch Plan | Notion" })?.filename, "Project Plan.docx");
});

test("versions, counters and duplicate suffixes go", () => {
  assert.equal(tidyDownloadName({ filename: "report_final_final_v2 (1).pdf" })?.filename, "Report.pdf");
  assert.equal(tidyDownloadName({ filename: "annual_report_2025_final.tar.gz" })?.filename, "Annual Report 2025.tar.gz");
});

test("a screenshot with no page has nothing to offer", () => {
  assert.equal(tidyDownloadName({ filename: "Screenshot 2026-10-24 at 12.34.56.png" }), null);
  assert.equal(tidyDownloadName({ filename: "IMG_20261024_8812.pdf" }), null);
  assert.equal(tidyDownloadName({ filename: "image.png" }), null);
  assert.equal(tidyDownloadName({ filename: "57557750-3c95-4ba0-957f-63e12bcba39e.jpg" }), null);
});

test("a screenshot takes the page's name", () => {
  assert.equal(tidyDownloadName({ filename: "Screenshot 2026-10-24 at 12.34.56.png", pageTitle: "Dashboard — Linear" })?.filename, "Dashboard.png");
  assert.equal(tidyDownloadName({ filename: "image.png", pageTitle: "A cat on a sofa" })?.filename, "A Cat on a Sofa.png");
  assert.equal(tidyDownloadName({ filename: "Untitled design (1).png", pageTitle: "Poster — Figma" })?.filename, "Poster.png");
});

test("a web address's slug becomes words", () => {
  assert.equal(tidyDownloadName({ filename: "Hello-World-master.zip" })?.filename, "Hello World Master.zip");
  assert.equal(tidyDownloadName({ filename: "annual-report.pdf" })?.filename, "Annual Report.pdf");
});

test("a dotted version survives the clean up", () => {
  assert.equal(tidyDownloadName({ filename: "Cra-0.1.30.dmg" })?.filename, "Cra 0.1.30.dmg");
  assert.equal(tidyDownloadName({ filename: "node-v22.11.0-darwin-arm64.tar.gz" })?.filename.includes("22.11.0"), true);
  assert.equal(tidyNameFor("Cra 0.1.30", "Cra-0.1.30.dmg")?.filename, "Cra 0.1.30.dmg");
});

test("a model's answer keeps its own wording and loses what a file name can't hold", () => {
  assert.equal(tidyNameFor("DM with Sara", "Screenshot 2026-09-26.png")?.filename, "DM with Sara.png");
  assert.equal(tidyNameFor("Fly.io Invoice Nov 3", "invoice_771100.pdf")?.filename, "Fly.io Invoice Nov 3.pdf");
  assert.equal(tidyNameFor("“Q3 Report.PDF”\nHope that helps", "x_1.pdf")?.filename, "Q3 Report.pdf");
  assert.equal(tidyNameFor("../../etc/passwd: a/b", "x_1.pdf")?.filename, "etc passwd a b.pdf");
  assert.equal(tidyNameFor("...hidden", "x_1.pdf")?.filename, "hidden.pdf");
  assert.equal(tidyNameFor("Report.app", "x_1.pdf")?.filename, "Report.pdf");
  assert.equal(tidyNameFor("download", "x_1.pdf"), null);
  assert.equal(tidyNameFor("Same", "Same.pdf"), null);
});

test("a model's answer has to keep the subject of a name that says something", () => {
  // The answers the on-device model gave when the page was about something else.
  assert.equal(modelTidyName("Acme Q3 2026 Report", "Cra-0.1.30.dmg"), null);
  assert.equal(modelTidyName("CV", "resume_final_v2.docx"), null);
  assert.equal(modelTidyName("Cra 0.1.30", "Cra-0.1.30.dmg")?.filename, "Cra 0.1.30.dmg");
  assert.equal(modelTidyName("Fly.io Invoice Nov 3", "invoice_771100_2026-11-03.pdf")?.filename, "Fly.io Invoice Nov 3.pdf");
  assert.equal(modelTidyName("Hello World", "Hello-World-master.zip")?.filename, "Hello World.zip");
  assert.equal(modelTidyName("Huracan S 02", "gw_hura_s_02.webp")?.filename, "Huracan S 02.webp");
});

test("a name that says nothing leaves the model free", () => {
  assert.equal(modelTidyName("Navan Lisbon Trip", "387494875.pdf")?.filename, "Navan Lisbon Trip.pdf");
  assert.equal(modelTidyName("Acme Q3 Report", "IMG_20261024_8812.pdf")?.filename, "Acme Q3 Report.pdf");
  assert.equal(modelTidyName("DM with Sara", "Screenshot 2026-09-26 at 11.12.18 PM.png")?.filename, "DM with Sara.png");
  assert.equal(modelTidyName("Stripe Payments", "data_export_1730000000.csv")?.filename, "Stripe Payments.csv");
});

test("names a person made are left alone", () => {
  assert.equal(tidyDownloadName({ filename: "My Report.pdf" }), null);
  assert.equal(tidyDownloadName({ filename: "Q4 2025 Roadmap.pdf" }), null);
  assert.equal(tidyDownloadName({ filename: "NASA Artemis 2 launch.avif" }), null);
  assert.equal(isUserNamedDownload("My Report.pdf", "invoice.pdf"), true);
  assert.equal(isUserNamedDownload("invoice.pdf", "invoice.pdf"), false);
  assert.equal(isUserNamedDownload("invoice (1).pdf", "invoice.pdf"), false);
  assert.equal(isUserNamedDownload("invoice.pdf", undefined), false);
});

test("the model's answer is cleaned with the download's own extension", () => {
  assert.equal(tidyNameFor("Close Up Astronaut Floating", "midjourney.png")?.filename, "Close Up Astronaut Floating.png");
  assert.equal(tidyNameFor("Huracan S 02.webp", "gw.webp")?.filename, "Huracan S 02.webp");
  assert.equal(tidyNameFor("  ", "gw.webp"), null);
  assert.equal(tidyNameFor("image", "gw.webp"), null);
});
