/*
 *                      Copyright 2024 Salto Labs Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import _ from 'lodash'
import { isInstanceElement, Element } from '@salto-io/adapter-api'
import { FilterCreator } from '../../filter'
import { WORKFLOW_TYPE_NAME } from '../../constants'

const filter: FilterCreator = ({ config }) => ({
  name: 'workflowV1RemovalFilter',
  onFetch: async (elements: Element[]) => {
    const { enableNewWorkflowAPI } = config.fetch
    if (enableNewWorkflowAPI) {
      _.remove(elements, element => isInstanceElement(element) && element.elemID.typeName === WORKFLOW_TYPE_NAME)
    }
  },
})

export default filter
