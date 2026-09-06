def test_get_api_supports_etag_revalidation(client):
    first = client.get("/api/health")
    assert first.status_code == 200
    etag = first.headers.get("etag")
    assert etag and etag.startswith('"') and etag.endswith('"')
    assert first.headers["cache-control"] == "no-cache"

    unchanged = client.get("/api/health", headers={"If-None-Match": etag})
    assert unchanged.status_code == 304
    assert unchanged.content == b""
    assert unchanged.headers["etag"] == etag
