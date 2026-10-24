use iso8601_timestamp::Timestamp;

use crate::File;

auto_derived_partial!(
    /// Registered Activity Application (ADR-0011)
    pub struct ActivityApplication {
        /// Application id, also the Activity Origin subdomain
        #[serde(rename = "_id")]
        pub id: String,
        /// Display name
        pub name: String,
        /// Short description
        #[serde(skip_serializing_if = "Option::is_none")]
        pub description: Option<String>,
        /// Icon
        #[serde(skip_serializing_if = "Option::is_none")]
        pub icon: Option<File>,
        /// Upstream URL serving the application root
        pub origin_url: String,
        /// Extra upstreams reachable through `/.proxy/{prefix}/`
        #[serde(default)]
        pub url_mappings: Vec<ActivityUrlMapping>,
        /// Maximum number of participants in one instance
        pub max_participants: i32,
        /// Skip the authorization consent dialog
        #[serde(skip_serializing_if = "crate::if_false", default)]
        pub first_party: bool,
        /// Disabled applications are hidden from clients and not proxied
        #[serde(skip_serializing_if = "crate::if_false", default)]
        pub enabled: bool,
        /// SHA-256 hex of the client secret
        #[serde(skip_serializing_if = "Option::is_none")]
        pub client_secret_hash: Option<String>,
        /// Creation timestamp
        pub created_at: Timestamp,
        /// Update timestamp
        pub updated_at: Timestamp,
    },
    "PartialActivityApplication"
);

auto_derived!(
    /// Route from `/.proxy/{prefix}/` on the Activity Origin to an upstream
    pub struct ActivityUrlMapping {
        pub prefix: String,
        pub target: String,
    }

    /// Clearable Activity Application fields
    pub enum FieldsActivityApplication {
        Description,
        Icon,
        ClientSecretHash,
    }
);

impl ActivityApplication {
    pub fn remove_field(&mut self, field: &FieldsActivityApplication) {
        match field {
            FieldsActivityApplication::Description => self.description = None,
            FieldsActivityApplication::Icon => self.icon = None,
            FieldsActivityApplication::ClientSecretHash => self.client_secret_hash = None,
        }
    }

    /// Activity Origin for this application from the `hosts.activities` template.
    pub fn activity_url(&self, template: &str) -> String {
        template.replace("{id}", &self.id)
    }

    /// Upstream base URL and remaining path for a request path on the Activity Origin.
    ///
    /// `/.proxy/{prefix}/rest` maps to the matching `url_mappings` target with
    /// `/rest`; every other path maps to `origin_url`. Returns `None` for an
    /// unknown `/.proxy/` prefix.
    pub fn upstream_for_path<'a>(&'a self, path: &'a str) -> Option<(&'a str, &'a str)> {
        let Some(rest) = path.strip_prefix("/.proxy/") else {
            return Some((self.origin_url.as_str(), path));
        };
        let (prefix, tail) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index..]),
            None => (rest, "/"),
        };
        self.url_mappings
            .iter()
            .find(|mapping| mapping.prefix == prefix)
            .map(|mapping| (mapping.target.as_str(), tail))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn application() -> ActivityApplication {
        ActivityApplication {
            id: "lab".into(),
            name: "Lab".into(),
            description: None,
            icon: None,
            origin_url: "http://web:5000/activities/lab".into(),
            url_mappings: vec![ActivityUrlMapping {
                prefix: "api".into(),
                target: "https://lab.example.com".into(),
            }],
            max_participants: 8,
            first_party: true,
            enabled: true,
            client_secret_hash: None,
            created_at: Timestamp::UNIX_EPOCH,
            updated_at: Timestamp::UNIX_EPOCH,
        }
    }

    #[test]
    fn activity_url_fills_template() {
        assert_eq!(
            application().activity_url("https://{id}.activities.syrnike13.ru"),
            "https://lab.activities.syrnike13.ru"
        );
    }

    #[test]
    fn upstream_routes_proxy_prefixes() {
        let app = application();
        assert_eq!(
            app.upstream_for_path("/index.html"),
            Some(("http://web:5000/activities/lab", "/index.html"))
        );
        assert_eq!(
            app.upstream_for_path("/.proxy/api/v1/score"),
            Some(("https://lab.example.com", "/v1/score"))
        );
        assert_eq!(
            app.upstream_for_path("/.proxy/api"),
            Some(("https://lab.example.com", "/"))
        );
        assert_eq!(app.upstream_for_path("/.proxy/unknown/x"), None);
    }
}
