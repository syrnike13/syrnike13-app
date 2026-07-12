use iso8601_timestamp::Timestamp;
use once_cell::sync::Lazy;
use regex::Regex;

use super::File;

#[cfg(feature = "validator")]
use validator::Validate;

pub static RE_BADGE_SLUG: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-z0-9_]+$").unwrap());

auto_derived_partial!(
    /// Badge catalog entry
    pub struct Badge {
        /// Unique Id
        #[cfg_attr(feature = "serde", serde(rename = "_id"))]
        pub id: String,
        /// Stable system slug
        pub slug: String,
        /// Display name
        pub name: String,
        /// Optional display description
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub description: Option<String>,
        /// Badge icon
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub icon: Option<File>,
        /// Whether normal user-facing payloads can include this badge
        #[cfg_attr(
            feature = "serde",
            serde(skip_serializing_if = "crate::if_false", default)
        )]
        pub visible: bool,
        /// Whether this badge is reserved for the premium system
        #[cfg_attr(
            feature = "serde",
            serde(skip_serializing_if = "crate::if_false", default)
        )]
        pub premium: bool,
        /// Global display order
        pub display_order: i32,
        /// Creation timestamp
        pub created_at: Timestamp,
        /// Update timestamp
        pub updated_at: Timestamp,
    },
    "PartialBadge"
);

auto_derived!(
    /// Optional fields on badge object
    pub enum FieldsBadge {
        Description,
        Icon,
    }

    /// Badge data attached to public user payloads
    pub struct UserBadge {
        /// Badge id
        #[cfg_attr(feature = "serde", serde(rename = "_id"))]
        pub id: String,
        /// Stable system slug
        pub slug: String,
        /// Display name
        pub name: String,
        /// Optional display description
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub description: Option<String>,
        /// Badge icon
        pub icon: File,
        /// Global display order
        pub order: i32,
    }

    /// New badge catalog data
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataCreateBadge {
        /// Stable system slug
        #[cfg_attr(
            feature = "validator",
            validate(length(min = 1, max = 64), regex = "RE_BADGE_SLUG")
        )]
        pub slug: String,
        /// Display name
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 64)))]
        pub name: String,
        /// Optional display description
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "validator", validate(length(max = 256)))]
        pub description: Option<String>,
        /// Uploaded badge icon file id
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 128)))]
        pub icon_file_id: Option<String>,
        /// Whether normal user-facing payloads can include this badge
        pub visible: bool,
        /// Whether this badge is reserved for the premium system
        pub premium: bool,
        /// Global display order
        pub display_order: i32,
    }

    /// Edited badge catalog data
    #[cfg_attr(feature = "validator", derive(Validate))]
    pub struct DataEditBadge {
        /// Stable system slug
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(
            feature = "validator",
            validate(length(min = 1, max = 64), regex = "RE_BADGE_SLUG")
        )]
        pub slug: Option<String>,
        /// Display name
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 64)))]
        pub name: Option<String>,
        /// Optional display description
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "validator", validate(length(max = 256)))]
        pub description: Option<String>,
        /// Uploaded badge icon file id
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        #[cfg_attr(feature = "validator", validate(length(min = 1, max = 128)))]
        pub icon_file_id: Option<String>,
        /// Whether normal user-facing payloads can include this badge
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub visible: Option<bool>,
        /// Whether this badge is reserved for the premium system
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub premium: Option<bool>,
        /// Global display order
        #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
        pub display_order: Option<i32>,
        /// Fields to remove from badge object
        #[cfg_attr(feature = "serde", serde(default))]
        pub remove: Vec<FieldsBadge>,
    }
);

#[cfg(test)]
mod tests {
    use super::RE_BADGE_SLUG;

    #[test]
    fn badge_slug_accepts_only_lowercase_digits_and_underscores() {
        assert!(RE_BADGE_SLUG.is_match("bug_hunter"));
        assert!(RE_BADGE_SLUG.is_match("premium2"));
        assert!(!RE_BADGE_SLUG.is_match("BugHunter"));
        assert!(!RE_BADGE_SLUG.is_match("bug-hunter"));
        assert!(!RE_BADGE_SLUG.is_match(""));
    }
}
