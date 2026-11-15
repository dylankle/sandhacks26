import "server-only";

const ENDPOINT = "https://api.brightdata.com/request";

export async function fetchWithBrightData(
  url: string,
  zone: string
): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization":
        `Bearer ${process.env.BRIGHTDATA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      zone,
      url,
      format: "raw",
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Bright Data request failed: ${response.status}`
    );
  }

  return response.text();
}

export async function searchProjects(query: string) {
  const searchURL = new URL(
    "https://www.google.com/search"
  );

  searchURL.searchParams.set("q", query);
  searchURL.searchParams.set("brd_json", "1");
  searchURL.searchParams.set("gl", "us");
  searchURL.searchParams.set("hl", "en");

  const result = await fetchWithBrightData(
    searchURL.toString(),
    process.env.BRIGHTDATA_SERP_ZONE!
  );

  return JSON.parse(result);
}

export async function retrieveProjectPage(
  url: string
) {
  return fetchWithBrightData(
    url,
    process.env.BRIGHTDATA_UNLOCKER_ZONE!
  );
}
