use syrnike_result::{create_error, Result};

use crate::{DiagnosticReport, DiagnosticReportQuery, DiagnosticReportStatus, ReferenceDb};

use super::AbstractDiagnosticReports;

#[async_trait]
impl AbstractDiagnosticReports for ReferenceDb {
    async fn insert_diagnostic_report(&self, report: &DiagnosticReport) -> Result<()> {
        let mut reports = self.diagnostic_reports.lock().await;
        if reports.contains_key(&report.id) {
            Err(create_database_error!("insert", "diagnostic_reports"))
        } else {
            reports.insert(report.id.clone(), report.clone());
            Ok(())
        }
    }

    async fn fetch_diagnostic_report(&self, id: &str) -> Result<DiagnosticReport> {
        self.diagnostic_reports
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_diagnostic_reports(
        &self,
        query: DiagnosticReportQuery,
    ) -> Result<Vec<DiagnosticReport>> {
        let mut reports = self
            .diagnostic_reports
            .lock()
            .await
            .values()
            .filter(|report| query.user_id.as_ref().is_none_or(|v| &report.user_id == v))
            .filter(|report| query.source.as_ref().is_none_or(|v| &report.source == v))
            .filter(|report| {
                query
                    .release_channel
                    .as_ref()
                    .is_none_or(|v| &report.release_channel == v)
            })
            .filter(|report| query.area.as_ref().is_none_or(|v| &report.area == v))
            .filter(|report| {
                query
                    .trigger_code
                    .as_ref()
                    .is_none_or(|v| &report.trigger_code == v)
            })
            .filter(|report| query.status.as_ref().is_none_or(|v| &report.status == v))
            .cloned()
            .collect::<Vec<_>>();
        reports.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        if let Some(before) = query.before {
            let Some(index) = reports.iter().position(|report| report.id == before) else {
                return Ok(Vec::new());
            };
            reports = reports.into_iter().skip(index + 1).collect();
        }
        reports.truncate(query.limit.clamp(1, 100));
        Ok(reports)
    }

    async fn update_diagnostic_report(
        &self,
        id: &str,
        status: DiagnosticReportStatus,
        notes: String,
    ) -> Result<()> {
        let mut reports = self.diagnostic_reports.lock().await;
        let report = reports.get_mut(id).ok_or_else(|| create_error!(NotFound))?;
        report.status = status;
        report.notes = notes;
        Ok(())
    }

    async fn fetch_expired_diagnostic_reports(&self, now: u64) -> Result<Vec<DiagnosticReport>> {
        Ok(self
            .diagnostic_reports
            .lock()
            .await
            .values()
            .filter(|report| report.expires_at <= now)
            .take(100)
            .cloned()
            .collect())
    }

    async fn delete_diagnostic_report(&self, id: &str) -> Result<()> {
        self.diagnostic_reports
            .lock()
            .await
            .remove(id)
            .map(|_| ())
            .ok_or_else(|| create_error!(NotFound))
    }
}

#[cfg(test)]
mod tests {
    use super::AbstractDiagnosticReports;
    use crate::{DiagnosticReport, DiagnosticReportQuery, DiagnosticReportStatus, ReferenceDb};

    fn report(id: &str, created_at: u64, user_id: &str) -> DiagnosticReport {
        DiagnosticReport {
            id: id.to_owned(),
            user_id: user_id.to_owned(),
            created_at,
            expires_at: created_at + 10,
            source: "desktop".to_owned(),
            release_channel: "nightly".to_owned(),
            app_version: "0.5.1".to_owned(),
            platform: "win32".to_owned(),
            area: "voice".to_owned(),
            severity: "error".to_owned(),
            trigger_code: "voice_failed".to_owned(),
            description: String::new(),
            bucket_id: "bucket".to_owned(),
            object_key: format!("diagnostics/{id}.jsonl.gz"),
            encryption_iv: "iv".to_owned(),
            size_bytes: 100,
            sha256: "hash".to_owned(),
            status: DiagnosticReportStatus::New,
            notes: String::new(),
        }
    }

    #[async_std::test]
    async fn filters_paginates_and_updates_reports() {
        let db = ReferenceDb::default();
        db.insert_diagnostic_report(&report("a", 1, "user-a"))
            .await
            .unwrap();
        db.insert_diagnostic_report(&report("b", 2, "user-b"))
            .await
            .unwrap();

        let filtered = db
            .fetch_diagnostic_reports(DiagnosticReportQuery {
                user_id: Some("user-a".to_owned()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "a");

        db.update_diagnostic_report("a", DiagnosticReportStatus::Resolved, "fixed".to_owned())
            .await
            .unwrap();
        let updated = db.fetch_diagnostic_report("a").await.unwrap();
        assert_eq!(updated.status, DiagnosticReportStatus::Resolved);
        assert_eq!(updated.notes, "fixed");
        assert_eq!(
            db.fetch_expired_diagnostic_reports(11).await.unwrap().len(),
            1
        );
    }
}
