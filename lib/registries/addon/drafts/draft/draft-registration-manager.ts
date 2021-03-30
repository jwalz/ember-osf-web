import { action, computed, set } from '@ember/object';
import { alias, filterBy, not, notEmpty, or } from '@ember/object/computed';
import { inject as service } from '@ember/service';
import { isEmpty } from '@ember/utils';
import { BufferedChangeset } from 'ember-changeset/types';
import { restartableTask, task, TaskInstance, timeout } from 'ember-concurrency';
import { taskFor } from 'ember-concurrency-ts';
import Intl from 'ember-intl/services/intl';
import Toast from 'ember-toastr/services/toast';

import DraftNode from 'ember-osf-web/models/draft-node';
import DraftRegistration, { DraftMetadataProperties } from 'ember-osf-web/models/draft-registration';
import NodeModel from 'ember-osf-web/models/node';
import ProviderModel from 'ember-osf-web/models/provider';
import SchemaBlock from 'ember-osf-web/models/schema-block';
import captureException, { getApiErrorMessage } from 'ember-osf-web/utils/capture-exception';

import {
    buildMetadataValidations,
    getPages,
    PageManager,
    RegistrationResponse,
} from 'ember-osf-web/packages/registration-schema';
import buildChangeset from 'ember-osf-web/utils/build-changeset';

type LoadDraftModelTask = TaskInstance<{
    draftRegistration: DraftRegistration,
    provider: ProviderModel,
}>;

export default class DraftRegistrationManager {
    // Required
    draftRegistrationTask!: LoadDraftModelTask;

    // Private
    @service intl!: Intl;
    @service toast!: Toast;

    currentPage!: number;
    registrationResponses!: RegistrationResponse;

    pageManagers: PageManager[] = [];
    metadataChangeset!: BufferedChangeset;
    schemaBlocks!: SchemaBlock[];

    @alias('draftRegistration.id') draftId!: string;
    @alias('draftRegistration.currentUserIsReadOnly') currentUserIsReadOnly!: boolean;
    @alias('draftRegistration.currentUserIsAdmin') currentUserIsAdmin!: boolean;
    @alias('provider.reviewsWorkflow') reviewsWorkflow?: string;
    @alias('draftRegistration.hasProject') hasProject?: boolean;
    @or('onPageInput.isRunning', 'onMetadataInput.isRunning') autoSaving!: boolean;
    @or('initializePageManagers.isRunning', 'initializeMetadataChangeset.isRunning') initializing!: boolean;
    @not('registrationResponsesIsValid') hasInvalidResponses!: boolean;
    @filterBy('pageManagers', 'isVisited', true) visitedPages!: PageManager[];
    @notEmpty('visitedPages') hasVisitedPages!: boolean;

    draftRegistration!: DraftRegistration;
    node?: NodeModel | DraftNode;
    provider!: ProviderModel;

    @computed('pageManagers.{[],@each.pageIsValid}')
    get registrationResponsesIsValid() {
        return this.pageManagers.every(pageManager => pageManager.pageIsValid) && this.metadataIsValid;
    }

    @computed('metadataChangeset.isValid')
    get metadataIsValid() {
        return this.metadataChangeset.isValid;
    }

    @computed('onInput.lastComplete')
    get lastSaveFailed() {
        const onPageInputLastComplete = taskFor(this.onPageInput).lastComplete;
        const pageInputFailed = onPageInputLastComplete ? onPageInputLastComplete.isError : false;
        const metadataInputFailed = onPageInputLastComplete
            ? onPageInputLastComplete.isError : false;
        return pageInputFailed || metadataInputFailed;
    }

    constructor(draftRegistrationTask: LoadDraftModelTask) {
        set(this, 'draftRegistrationTask', draftRegistrationTask);
        taskFor(this.initializePageManagers).perform();
        taskFor(this.initializeMetadataChangeset).perform();
    }

    @restartableTask
    async saveAllVisitedPages() {
        if (this.pageManagers && this.pageManagers.length) {
            this.pageManagers
                .filter(pageManager => pageManager.isVisited)
                .forEach(this.updateRegistrationResponses.bind(this));

            const { registrationResponses } = this;

            this.draftRegistration.setProperties({
                registrationResponses,
            });

            try {
                await this.draftRegistration.save();
            } catch (e) {
                captureException(e);
                throw e;
            }
        }
    }

    @restartableTask
    async onPageInput(currentPageManager: PageManager) {
        await timeout(5000); // debounce

        if (currentPageManager && currentPageManager.schemaBlockGroups) {
            this.updateRegistrationResponses(currentPageManager);

            this.draftRegistration.setProperties({
                registrationResponses: this.registrationResponses,
            });
            try {
                await this.draftRegistration.save();
            } catch (e) {
                const errorMessage = this.intl.t('registries.drafts.draft.form.failed_auto_save');
                captureException(e, { errorMessage });
                this.toast.error(getApiErrorMessage(e), errorMessage);
                throw e;
            }
        }
    }

    @task
    async initializePageManagers() {
        const { draftRegistration, provider } = await this.draftRegistrationTask;
        set(this, 'draftRegistration', draftRegistration);
        set(this, 'provider', provider);
        try {
            const node = await this.draftRegistration.branchedFrom;
            set(this, 'node', node);
        } catch (e) {
            captureException(e);
            set(this, 'node', undefined);
        }
        const registrationSchema = await this.draftRegistration.registrationSchema;
        const schemaBlocks = await registrationSchema.loadAll('schemaBlocks');
        set(this, 'schemaBlocks', schemaBlocks);
        const pages = getPages(schemaBlocks);
        const { registrationResponses } = this.draftRegistration;

        set(this, 'registrationResponses', registrationResponses || {});

        const pageManagers = pages.map(
            pageSchemaBlocks => new PageManager(
                pageSchemaBlocks,
                this.registrationResponses || {},
                this.node,
            ),
        );

        set(this, 'pageManagers', pageManagers);
    }

    @task
    async initializeMetadataChangeset() {
        const { draftRegistration } = await this.draftRegistrationTask;
        const metadataValidations = buildMetadataValidations();
        const metadataChangeset = buildChangeset(draftRegistration, metadataValidations);
        set(this, 'metadataChangeset', metadataChangeset);
    }

    @restartableTask
    async onMetadataInput() {
        await timeout(5000); // debounce
        this.updateMetadataChangeset();
        try {
            await this.draftRegistration.save();
        } catch (e) {
            const errorMessage = this.intl.t('registries.drafts.draft.metadata.failed_auto_save');
            captureException(e, { errorMessage });
            this.toast.error(getApiErrorMessage(e), errorMessage);
            throw e;
        }
    }

    @action
    onPageChange(currentPage: number) {
        if (this.hasVisitedPages) {
            this.validateAllVisitedPages();
            taskFor(this.saveAllVisitedPages).perform();
        }
        this.markCurrentPageVisited(currentPage);
    }

    @action
    markAllPagesVisited() {
        this.pageManagers.forEach(pageManager => {
            pageManager.setPageIsVisited();
        });
    }

    @action
    markCurrentPageVisited(currentPage?: number) {
        const { pageManagers } = this;
        if (!isEmpty(pageManagers) && typeof currentPage !== 'undefined') {
            pageManagers[currentPage].setPageIsVisited();
        }
    }

    @action
    validateAllVisitedPages() {
        this.metadataChangeset.validate();
        this.visitedPages
            .forEach(pageManager => {
                pageManager.changeset!.validate();
            });
    }

    updateMetadataChangeset() {
        const { metadataChangeset, draftRegistration } = this;
        Object.values(DraftMetadataProperties).forEach(metadataKey => {
            set(
                draftRegistration,
                metadataKey,
                metadataChangeset!.get(metadataKey),
            );
        });
    }

    updateRegistrationResponses(pageManager: PageManager) {
        const { registrationResponses } = this;
        const { changeset } = pageManager;
        if (pageManager.schemaBlockGroups) {
            pageManager.schemaBlockGroups
                .mapBy('registrationResponseKey')
                .filter(Boolean)
                .forEach(registrationResponseKey => {
                    set(
                        registrationResponses,
                        registrationResponseKey,
                        changeset!.get(registrationResponseKey),
                    );
                });
        }
    }
}
