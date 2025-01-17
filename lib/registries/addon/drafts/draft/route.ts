import Store from '@ember-data/store';
import { getOwner } from '@ember/application';
import { action } from '@ember/object';
import Route from '@ember/routing/route';
import RouterService from '@ember/routing/router-service';
import { inject as service } from '@ember/service';
import { waitFor } from '@ember/test-waiters';
import { task } from 'ember-concurrency';
import { taskFor } from 'ember-concurrency-ts';

import requireAuth from 'ember-osf-web/decorators/require-auth';
import DraftRegistration from 'ember-osf-web/models/draft-registration';
import ProviderModel from 'ember-osf-web/models/provider';
import SubjectModel from 'ember-osf-web/models/subject';
import Analytics from 'ember-osf-web/services/analytics';
import captureException from 'ember-osf-web/utils/capture-exception';
import { notFoundURL } from 'ember-osf-web/utils/clean-url';
import DraftRegistrationManager, { LoadDraftModelTask } from 'registries/drafts/draft/draft-registration-manager';
import NavigationManager from 'registries/drafts/draft/navigation-manager';

export interface DraftRouteModel {
    draftRegistrationManager: DraftRegistrationManager;
    navigationManager: NavigationManager;
}

@requireAuth()
export default class DraftRegistrationRoute extends Route {
    @service analytics!: Analytics;
    @service store!: Store;
    @service router!: RouterService;

    @task
    @waitFor
    async loadDraftRegistrationAndNode(draftId: string) {
        try {
            const draftRegistration: DraftRegistration = await this.store.findRecord(
                'draft-registration',
                draftId,
                { adapterOptions: { include: 'branched_from' } },
            );
            if (draftRegistration.modelName === 'registration') {
                this.transitionTo('overview', draftRegistration.id);
            } else if (draftRegistration.currentUserIsReadOnly) {
                this.replaceWith('drafts.draft.review', draftId);
            }
            const [subjects, provider]:
                [SubjectModel[], ProviderModel] = await Promise.all([
                    draftRegistration.loadAll('subjects'),
                    draftRegistration.provider,
                ]);

            draftRegistration.setProperties({ subjects });
            return { draftRegistration, provider };
        } catch (error) {
            captureException(error);
            return this.transitionTo('page-not-found', notFoundURL(this.router.currentURL));
        }
    }

    model(params: { id: string }): DraftRouteModel {
        const { id: draftId } = params;
        const draftRegistrationTask = taskFor(this.loadDraftRegistrationAndNode).perform(draftId) as LoadDraftModelTask;
        const draftRegistrationManager = new DraftRegistrationManager(getOwner(this), draftRegistrationTask);
        const navigationManager = new NavigationManager(draftRegistrationManager);
        return {
            navigationManager,
            draftRegistrationManager,
        };
    }

    @action
    didTransition() {
        this.analytics.trackPage();
    }
}
