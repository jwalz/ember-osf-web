import { assert } from '@ember/debug';
import { action } from '@ember/object';
import Route from '@ember/routing/route';
import { inject as service } from '@ember/service';

import Analytics from 'ember-osf-web/services/analytics';
import { getPageIndex } from 'ember-osf-web/utils/page-param';

import RevisionNavigationManager, { RevisionRoute } from 'registries/edit-revision/nav-manager';
import RevisionManager from 'registries/edit-revision/revision-manager';
import { EditRevisionRouteModel } from '../route';

export interface RevisionPageRouteModel {
    revisionManager: RevisionManager;
    navigationManager: RevisionNavigationManager;
    pageIndex?: number;
    page: string;
}

export default class RevisionPageRoute extends Route {
    @service analytics!: Analytics;

    model(params: { page: string }): RevisionPageRouteModel {
        const { page } = params;
        const pageIndex = getPageIndex(page);
        const editRevisionRouteModel = this.modelFor('edit-revision') as EditRevisionRouteModel;
        const { revisionManager, navigationManager } = editRevisionRouteModel;

        assert('pageIndex must be defined on the Page route', typeof pageIndex !== 'undefined');
        navigationManager.setPageAndRoute(RevisionRoute.Page, pageIndex as number);

        return {
            revisionManager,
            navigationManager,
            pageIndex,
            page,
        };
    }

    @action
    didTransition() {
        this.analytics.trackPage();
    }
}
