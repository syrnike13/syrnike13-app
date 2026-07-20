use syrnike_result::Result;

use crate::{DiagnosticReport, DiagnosticReportQuery, DiagnosticReportStatus};

#[cfg(feature = "mongodb")]
mod mongodb;
mod reference;

#[async_trait]
pub trait AbstractDiagnosticReports: Sync + Send {
    async fn insert_diagnostic_report(&self, report: &DiagnosticReport) -> Result<()>;
    async fn finalize_diagnostic_report(
        &self,
        id: &str,
        encryption_iv: String,
        expires_at: u64,
    ) -> Result<()>;
    async fn fetch_diagnostic_report(&self, id: &str) -> Result<DiagnosticReport>;
    async fn fetch_diagnostic_reports(
        &self,
        query: DiagnosticReportQuery,
    ) -> Result<Vec<DiagnosticReport>>;
    async fn update_diagnostic_report(
        &self,
        id: &str,
        status: DiagnosticReportStatus,
        notes: String,
    ) -> Result<()>;
    async fn fetch_expired_diagnostic_reports(&self, now: u64) -> Result<Vec<DiagnosticReport>>;
    async fn delete_diagnostic_report(&self, id: &str) -> Result<()>;
}
