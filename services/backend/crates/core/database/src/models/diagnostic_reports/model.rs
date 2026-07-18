auto_derived!(
    #[serde(rename_all = "snake_case")]
    pub enum DiagnosticReportStatus {
        New,
        Investigating,
        Resolved,
    }
);

auto_derived!(
    /// Metadata for one encrypted client diagnostic bundle stored in S3.
    pub struct DiagnosticReport {
        #[serde(rename = "_id")]
        pub id: String,
        pub user_id: String,
        pub created_at: u64,
        pub expires_at: u64,
        pub source: String,
        pub release_channel: String,
        pub app_version: String,
        pub platform: String,
        pub area: String,
        pub severity: String,
        pub trigger_code: String,
        pub description: String,
        pub bucket_id: String,
        pub object_key: String,
        pub encryption_iv: String,
        pub size_bytes: u64,
        pub sha256: String,
        pub status: DiagnosticReportStatus,
        #[serde(default)]
        pub notes: String,
    }
);

#[derive(Clone, Debug, Default)]
pub struct DiagnosticReportQuery {
    pub before: Option<String>,
    pub user_id: Option<String>,
    pub source: Option<String>,
    pub release_channel: Option<String>,
    pub area: Option<String>,
    pub trigger_code: Option<String>,
    pub status: Option<DiagnosticReportStatus>,
    pub limit: usize,
}
