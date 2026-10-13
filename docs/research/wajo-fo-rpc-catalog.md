# Wajo backend RPC catalog (from the public access table)

Extracted 2026-10-12 with REA static analysis from `rpc-access.gen-*.js` on assets.wajo.ai: service `wajoai.agentnet.v1.AgentNetService`, 224 methods, with the client-side access rule (`allow` = any signed-in user, `allow_individual` = individual accounts, `deny` = not callable from the consumer client; many are internal, admin or sweep jobs) and the REST route where one is mapped. Names are facts about their system; nothing here is their code.

| Method | Access | Entitlement | Route |
|---|---|---|---|
| ActivateAgentSetup | allow_individual |  | POST /v1/agents/{agent_id}/setup:activate |
| AddAgentCollaborator | deny |  | POST /v1/agents/{agent_id}/collaborators |
| AddShoppingBasketItem | deny |  | POST /v1/agents/{agent_id}/shoppingBasket:addItem |
| AnalyzePostCall | deny |  |  |
| AnalyzeTaskValidationPatterns | deny |  | POST /v1/admin/taskvalidation:analyze |
| AskEscalationUser | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:askUser |
| AttachMCPServer | deny |  | POST /v1/agents/{agent_id}/mcp-servers/{mcp_server_id}:attach |
| AttachSkill | deny |  | POST /v1/skills/{skill_id}:attach |
| AttestAgentRun | deny |  |  |
| BatchListAgentPhoneNumbers | deny |  | POST /v1/agents:batchListPhoneNumbers |
| BindSlackDMReplyCapability | deny |  |  |
| BuyCart | deny |  | POST /v1/agents/{agent_id}/shoppingBasket:buy |
| CanReadConversations | deny |  |  |
| CancelClaim | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:cancelClaim |
| CancelEAPurchase | allow_individual |  | POST /v1/assist/purchases/{purchase_id}:cancel |
| ChargeEAPurchase | allow_individual |  | POST /v1/assist/purchases/{purchase_id}:charge |
| CheckAgentViewers | deny |  |  |
| CheckAliasVerificationCode | deny |  |  |
| CheckSessionRunnable | allow |  | GET /v1/sessions/{session_id}:checkRunnable |
| CheckoutShoppingBasket | deny |  | POST /v1/agents/{agent_id}/shoppingBasket:checkout |
| ClaimEscalation | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:claim |
| ComputeAgentPerformance | deny |  | GET /v1/agents/{agent_id}/performance |
| ComputeHeartbeatTier | deny |  |  |
| ConfirmEAPurchase | allow_individual |  | POST /v1/assist/purchases/{purchase_id}:confirm |
| CopyAgent | deny |  | POST /v1/agents/{agent_id}:copy |
| CopyAgentForOperator | deny |  | POST /v1/admin/agents:copyForOperator |
| CreateAgent | deny |  | POST /v1/agents |
| CreateConnector | allow_individual |  | POST /v1/connectors |
| CreateMCPServer | allow |  | POST /v1/mcp-servers |
| CreateSessionArtifact | deny |  | POST /v1/admin/sessionArtifacts |
| CreateSkill | deny |  | POST /v1/skills |
| CreateUserWebhook | deny | mcp | POST /v1/webhooks |
| DeleteAgent | deny |  | DELETE /v1/agents/{agent_id} |
| DeleteAgentReportRuns | deny |  | DELETE /v1/agents/{agent_id}/reportRuns |
| DeleteConnector | allow_individual |  | DELETE /v1/connectors/{connector_id} |
| DeleteEscalationSiteLogin | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:deleteSiteLogin |
| DeleteMCPServer | allow |  | DELETE /v1/mcp-servers/{mcp_server_id} |
| DeleteOwnReportRuns | deny |  | DELETE /v1/report-runs |
| DeleteSession | allow |  | DELETE /v1/sessions/{session_id} |
| DeleteSkill | deny |  | DELETE /v1/skills/{skill_id} |
| DeleteUserWebhook | deny | mcp | DELETE /v1/webhooks/{webhook_id} |
| DeleteVoiceSession | deny |  |  |
| DeliverStagedItem | deny |  |  |
| DeliverUserWebhook | deny |  | POST /v1/webhooks/{webhook_id}:deliver |
| DetachMCPServer | deny |  | POST /v1/agents/{agent_id}/mcp-servers/{mcp_server_id}:detach |
| DetachSkill | deny |  | POST /v1/skills/{skill_id}:detach |
| DisableAgentInstallation | deny |  | POST /v1/orgs/{org_id}/agent-installations/{installation_id}:disable |
| DismissAgentSetup | allow_individual |  | POST /v1/agents/{agent_id}/setup:dismiss |
| DismissAttentionItem | allow |  | POST /v1/attention/{id}:dismiss |
| DismissSocialDraft | allow |  | POST /v1/social-drafts/{id}:dismiss |
| DispatchXActivityEvent | deny |  |  |
| EnableAgentInstallation | deny |  | POST /v1/orgs/{org_id}/agent-installations/{installation_id}:enable |
| EnqueuePostCallAnalysis | deny |  |  |
| EnrollEAPoolMember | deny |  |  |
| EnsureGoogleWatches | deny |  |  |
| EvaluateHeartbeatTick | deny |  |  |
| ExtendEscalationDeadline | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:extendDeadline |
| ExtractCallRecords | deny |  |  |
| FailEAPurchase | allow_individual |  | POST /v1/assist/purchases/{purchase_id}:fail |
| GenerateSessionId | allow |  | POST /v1/agents/{agent_id}/sessions:generateId |
| GenerateSessionIdForAgent | deny |  |  |
| GenerateSessionIdForUser | deny |  |  |
| GetAgent | deny |  | GET /v1/agents/{agent_id} |
| GetAgentAccess | deny |  | GET /v1/agents/{agent_id}/access |
| GetAgentPrivacyPosture | deny |  |  |
| GetAgentPublicKey | deny |  |  |
| GetAgentPublisherOrigin | deny |  |  |
| GetAgentReportRun | deny |  | GET /v1/report-run |
| GetArtifactURL | allow |  | GET /v1/artifacts/{artifact_id}:signedURL |
| GetConnector | allow_individual |  | GET /v1/connectors/{connector_id} |
| GetConnectorSecretStatus | allow_individual |  | GET /v1/connectors/{connector_id}:secretStatus |
| GetEAPurchase | allow_individual |  | GET /v1/assist/purchases/{purchase_id} |
| GetEscalation | allow_individual |  | GET /v1/assist/escalations/{escalation_id} |
| GetEscalationAgentCardEvidence | allow_individual |  | GET /v1/assist/escalations/{escalation_id}/agentCards/{reservation_id}/evidence |
| GetEscalationArtifactURL | allow_individual |  | GET /v1/assist/escalations/{escalation_id}/artifacts/{file_id}:signedURL |
| GetEscalationCardStatus | allow_individual |  | GET /v1/assist/escalations/{escalation_id}/cardStatus |
| GetMCPServer | allow |  | GET /v1/mcp-servers/{mcp_server_id} |
| GetMyEANotificationPrefs | allow_individual |  | GET /v1/assist/notification-prefs |
| GetMyEAStatus | allow |  | GET /v1/assist/status |
| GetMyEATestMode | allow_individual |  | GET /v1/assist/testmode |
| GetSession | allow |  | GET /v1/sessions/{session_id} |
| GetShoppingBasket | deny |  | GET /v1/agents/{agent_id}/shoppingBasket |
| GetSkill | deny |  | GET /v1/skills/{skill_id} |
| GetTaskValidationMetrics | deny |  | POST /v1/admin/taskvalidation:metrics |
| GetVoiceConfigDefaults | deny |  | GET /v1/voice-config-defaults |
| IngestThreadAttachments | deny |  |  |
| InstallAgent | deny |  | POST /v1/orgs/{org_id}/agent-installations |
| ListAccessibleAgentRefs | deny |  | GET /v1/agents:accessibleRefs |
| ListAgentBuilderConversations | deny |  | GET /v1/agents/{agent_id}/builder-conversations |
| ListAgentCollaborators | deny |  | GET /v1/agents/{agent_id}/collaborators |
| ListAgentInstallations | deny |  | GET /v1/orgs/{org_id}/agent-installations |
| ListAgentPhoneNumbers | allow |  | GET /v1/agents/{agent_id}/phone-numbers |
| ListAgentReportRunMeta | deny |  | GET /v1/report-runs |
| ListAgentReportRuns | deny |  | GET /v1/agents/{agent_id}/reportRuns |
| ListAgentTelegramBots | allow |  | GET /v1/agents/{agent_id}/telegram-bots |
| ListAgents | deny |  | GET /v1/agents |
| ListConnectors | allow_individual |  | GET /v1/connectors |
| ListDueStagedItems | deny |  |  |
| ListEAPurchases | allow_individual |  | GET /v1/assist/escalations/{escalation_id}/purchases |
| ListGoogleWatchCandidates | deny |  |  |
| ListMCPServers | allow |  | GET /v1/mcp-servers |
| ListMyAttentionItems | allow |  | GET /v1/attention:mine |
| ListMyEscalationRequests | allow |  | GET /v1/escalations:mine |
| ListMyEscalations | allow_individual |  | GET /v1/assist/escalations |
| ListMyGroupSessions | allow |  | GET /v1/sessions:mineGroups |
| ListMyRunChannels | allow |  | GET /v1/runs:mineChannels |
| ListMyRuns | allow |  | GET /v1/runs:mine |
| ListMySocialDrafts | allow |  | GET /v1/social-drafts:mine |
| ListPublicAgents | allow |  | GET /v1/publicAgents |
| ListRecentSessions | allow |  | GET /v1/sessions:recent |
| ListSessionArtifacts | allow |  | GET /v1/sessions/{session_id}/artifacts |
| ListSessionEvents | allow |  | GET /v1/sessions/{session_id}/events |
| ListSessions | allow |  | GET /v1/sessions |
| ListSkills | deny |  | GET /v1/skills |
| ListToolCatalog | deny |  | GET /v1/toolCatalog |
| ListUserWebhooks | deny | mcp | GET /v1/webhooks |
| ListVoices | deny |  | GET /v1/voices |
| ListWorkspaceAgentRoster | deny |  | GET /v1/orgs/{org_id}/agent-roster |
| LookupAgentByHandle | allow |  | GET /v1/agentHandles/{handle} |
| LookupPublicAgent | allow |  | GET /v1/publicAgents/{public_name} |
| MarkSocialDraftPosted | allow |  | POST /v1/social-drafts/{id}:posted |
| MintEAPurchaseCard | allow_individual |  | POST /v1/assist/purchases |
| MintVoiceSession | deny |  |  |
| MoveAgent | deny |  | POST /v1/agents/{agent_id}:move |
| NotifyCallOwner | deny |  |  |
| NotifyContactInteraction | deny |  |  |
| NotifyCredentialSaved | deny |  |  |
| NotifyFoLinkRequest | deny |  |  |
| NotifyOAuthGrantCompleted | deny |  |  |
| NotifyOAuthGrantRevoked | deny |  |  |
| NotifyOAuthGrantSignInRequired | deny |  |  |
| NotifyUserProfileChanged | deny |  |  |
| OpenRoomSidebar | allow |  | POST /v1/sessions/{session_id}:openSidebar |
| PinSession | allow |  | POST /v1/sessions/{session_id}:pin |
| PollXMentions | deny |  | POST /v1/admin/x-mentions:poll |
| PrecheckHeartbeatDuty | deny |  |  |
| ProcessRampWebhookEvent | deny |  |  |
| PublishAgent | deny |  | POST /v1/agents/{agent_id}:publish |
| PublishReportRun | deny |  | POST /v1/report-runs |
| PurgeAgentDriveFiles | deny |  | POST /v1/users/{target_user_id}:purgeDriveFiles |
| PurgeProjectsData | deny |  |  |
| PurgeUserAgentData | deny |  |  |
| RateConversationIdle | deny |  | POST /v1/sessions/{session_id}:rateIdle |
| RateServiceAgentInteraction | deny |  |  |
| RateVoiceConversation | deny |  |  |
| ReconcileConversations | deny |  | POST /v1/admin/conversations:reconcile |
| RecordEAPurchaseMerchantReference | allow_individual |  | POST /v1/assist/purchases/{purchase_id}:reference |
| RecordGroupContextTurn | deny |  |  |
| RecordOwnerDm | deny |  |  |
| RecordSmsGroupMembership | deny |  |  |
| RecordTextDeliveryFailure | deny |  |  |
| RecordTextReceipt | deny |  |  |
| RefreshMCPServer | allow |  | POST /v1/mcp-servers/{mcp_server_id}:refresh |
| RefreshMySuggestionCards | allow |  | POST /v1/attention/suggestions:refresh |
| ReleaseEscalationAgentCard | allow_individual |  | POST /v1/assist/escalations/{escalation_id}/agentCards/{reservation_id}:release |
| RemoveAgentCollaborator | deny |  | DELETE /v1/agents/{agent_id}/collaborators/{user_id} |
| RemoveShoppingBasketItem | deny |  | POST /v1/agents/{agent_id}/shoppingBasket:removeItem |
| RenameSession | allow |  | POST /v1/sessions/{session_id}:rename |
| ReorderMySuggestionCards | allow |  | POST /v1/attention/suggestions:reorder |
| ReorderPinnedSession | allow |  | POST /v1/sessions/{session_id}:reorderPin |
| ReplayXMention | deny |  | POST /v1/admin/x-mentions:replay |
| ReportEscalationSiteLoginOutcome | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:reportSiteLoginOutcome |
| ReportOwnerCallAnswered | deny |  |  |
| ResolveAgentByPhoneNumber | deny |  |  |
| ResolveAgentByPublicName | deny |  | GET /v1/agents:resolveByPublicName |
| ResolveAgentByTelegramBot | deny |  |  |
| ResolveAgentKBScope | deny |  |  |
| ResolveArtifactInstallationScope | deny |  |  |
| ResolveAttentionItem | allow |  | POST /v1/attention/{id}:resolve |
| ResolveEscalation | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:resolve |
| ResolveOrgMemberRole | deny |  |  |
| ResolveOwnerCallFrom | allow |  | POST /v1/agents/{agent_id}:resolveOwnerCallFrom |
| ResolveOwnerTextLine | allow |  | POST /v1/agents/{agent_id}:resolveOwnerTextLine |
| ResolveReplyByMessageId | deny |  | POST /v1/admin/sessions:resolveReplyByMessageId |
| ResolveReplyBySender | deny |  | POST /v1/admin/sessions:resolveReplyBySender |
| ResolveReplyToken | deny |  | POST /v1/admin/sessions:resolveReplyToken |
| ResolveSessionByChannelThread | deny |  |  |
| ResolveSessionByMessageId | deny |  | POST /v1/admin/sessions:resolveByMessageId |
| ResolveSessionsByExternalThread | deny |  | POST /v1/admin/sessions:resolveByExternalThread |
| ResolveSmsReplyBinding | deny |  |  |
| ResolveThreadAttachments | deny |  |  |
| ResolveThreadInstallations | deny |  | POST /v1/admin/sessions:resolveThreadInstallations |
| RevealEAPurchaseCard | allow_individual |  | POST /v1/assist/purchases/{purchase_id}:reveal |
| RevealEscalationSiteLogin | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:revealSiteLogin |
| RevokeExternalReplyAccess | deny |  | POST /v1/sessions/{session_id}:revokeExternalReplyAccess |
| RotateAgentKey | deny |  |  |
| RunAgent | allow |  | POST /v1/sessions/{session_id}:run |
| RunAgentLongRunning | allow |  | POST /v1/sessions/{session_id}:runLongRunning |
| RunAgentLongRunningForUser | deny |  |  |
| RunAgentPrincipalLongRunning | deny |  |  |
| RunAgentTask | deny |  | POST /v1/sessions/{session_id}:runTask |
| RunModelDeferralTask | deny |  | POST /v1/model-deferrals/{dedup_key}:run |
| RunPostCallAnalysisTask | deny |  | POST /v1/sessions/{session_id}:analyzePostCallTask |
| SaveEscalationSiteLogin | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:saveSiteLogin |
| SearchActionProviders | deny |  | POST /v1/action-providers:search |
| SearchSessions | allow |  | POST /v1/sessions:search |
| SendEscalationFollowUp | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:followUp |
| SendEscalationProgressNote | allow_individual |  | POST /v1/assist/escalations/{escalation_id}:progressNote |
| SendGroupOutsiderInvites | deny |  |  |
| SetDocumentSharing | allow |  | POST /v1/documents/{document_id}:setSharing |
| SetMyEATestMode | allow_individual |  | POST /v1/assist/testmode |
| StartAppVoiceCall | allow |  | POST /v1/voice:startAppCall |
| StartEASession | allow_individual |  | POST /v1/assist/session |
| StopAgentRun | allow |  | POST /v1/sessions/{session_id}:stop |
| SuggestAgentPreview | deny |  | POST /v1/agents/{agent_id}:suggestPreview |
| SuggestPromptTitle | allow |  | POST /v1/prompts:suggestTitle |
| SummarizeRunOutcome | deny |  | POST /v1/runs/{invocation_id}:summarize |
| SweepCardReconciliation | deny |  | POST /v1/admin/card-reconciliation:sweep |
| SweepEscalations | deny |  | POST /v1/admin/escalations:sweep |
| SweepGoalReviews | deny |  | POST /v1/admin/goal-reviews:sweep |
| SweepRatingBackstop | deny |  | POST /v1/admin/rating-backstop:sweep |
| SyncSandboxFork | deny |  | POST /v1/agents/{agent_id}:syncSandboxFork |
| TestUserWebhook | deny | mcp | POST /v1/webhooks/{webhook_id}:test |
| TopUpSyntheticQueue | deny |  | POST /v1/admin/synthetic-queue:topup |
| UninstallAgentInstallation | deny |  | POST /v1/orgs/{org_id}/agent-installations/{installation_id}:uninstall |
| UnpinSession | allow |  | POST /v1/sessions/{session_id}:unpin |
| UnpublishAgent | deny |  | POST /v1/agents/{agent_id}:unpublish |
| UpdateAgent | deny |  | PATCH /v1/agents/{agent.id} |
| UpdateConnector | allow_individual |  | PATCH /v1/connectors/{connector.id} |
| UpdateMCPServer | allow |  | PATCH /v1/mcp-servers/{mcp_server.id} |
| UpdateMyEANotificationPrefs | allow_individual |  | POST /v1/assist/notification-prefs |
| UpdateSkill | deny |  | PATCH /v1/skills/{skill.id} |
| WatchSession | allow |  | POST /v1/sessions/{session_id}:watch |
| WriteVoiceCallMetrics | deny |  |  |
